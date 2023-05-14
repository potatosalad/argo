import * as VarInt from './varint'
import { BackreferenceWriterTracker, BytesWriter, DeduplicatingWriter, Writer } from './dedup'
import { Label, LabelKind } from './label'
import { Wire } from './wire'
import { BitSet } from './bitset'
import { writeFileSync } from 'fs'
import { Buf } from './buf'

const DEBUG = true

export class CedarEncoder {
  private static utf8 = new TextEncoder()
  private static utf8encode = this.utf8.encode.bind(this.utf8)

  private writers: Map<Wire.DedupeKey, Writer<any>> = new Map()
  public tracked: any[] = []
  private nonNullPos = -1

  constructor(readonly buf: Buf = new Buf()) { }

  track = (kind: string, value: any, length: number) => {
    if (DEBUG) this.tracked.push({ pos: this.buf.position, kind, value, bytes: this.buf.uint8array })
  }

  log = (msg: string | object) => {
    if (DEBUG) {
      if (typeof msg === 'string') this.tracked.push({ pos: this.buf.position, msg })
      else this.tracked.push({ pos: this.buf.position, ...msg })
    }
  }

  getResult(): Buf {
    const header = this.buildHeader()
    let dataBytesNeeded = 0
    const deduperLengthHeaders = new Map()
    const bufLength = Label.encode(BigInt(this.buf.length))

    // calculate how much space we need for block values, which go in a series of blocks at the start
    for (const writer of this.writers.values()) {
      let deduperBytesNeeded = 0
      for (const value of writer.valuesAsBytes) {
        deduperBytesNeeded += value.length
      }
      const deduperLengthHeader = Label.encode(BigInt(deduperBytesNeeded))
      deduperLengthHeaders.set(writer, deduperLengthHeader)
      dataBytesNeeded += deduperBytesNeeded // reserve space for data
      dataBytesNeeded += deduperLengthHeader.length // reserve space for length header
    }

    const dataLength = header.length + dataBytesNeeded + bufLength.length + this.buf.length
    const buf = new Buf(dataLength)

    // write the header
    buf.write(header)

    // write scalar blocks
    for (const [dedupeKey, deduper] of this.writers.entries()) {
      console.log('writing block for', dedupeKey, 'with', deduper.valuesAsBytes.length, 'values', deduperLengthHeaders.get(deduper))
      buf.write(deduperLengthHeaders.get(deduper)) // write length of block
      for (const value of deduper.valuesAsBytes) {
        buf.write(value) // write each value in the block
      }
    }

    // write message length
    buf.write(bufLength)
    // write message data
    buf.writeBuf(this.buf)
    if (buf.length != buf.capacity) throw 'Programmer error: incorrect result length' + buf.length + ', expected' + buf.capacity
    return buf


    // TODO: decide what order to write dedupe blocks in. 
    // it needs to always match on both sides.
    // perhaps: FLOAT, INT, BYTES, STRING?
    // basically order of most to least likely to be 0, except keeping bytes and string together
    // FLOAT, INT, ID, ENUM, STRING, BYTES
    // idea: write each built-in block, then write custom blocks (which require a dedup key along with a length header)
    // BOOL, NULL, ARRAY, OBJECT never get de-duped.


    /*
    ideas for scalar block layout

    * in main message, Labeled values always correspond to an in-block entry. if length given,
    read next value from corresponding block. if backref, use backref from that block. if null, null.
    * that applies to string, id, bytes, enum, int32 (due to varint encoding EDIT: nope, since they can be negative of course), and array.
    null, bool are always inlined.
    object is always inlined, simply because it avoids so much re-writing at the end and keeps things simple.
    nullable values are ALSO written into blocks--this means null/non-null markers are inlined, but the value is not,DDF
    and this separation makes both halves more compressible.o
    this really just leaves non-null floats (and any future FIXED). these are always inlined.
    custom scalars get their own dedupers, and therefore their own blocks.
    we must create the block when we come across the first non-null value in the message,
    and we don't even know it is present until we arrive at it.
    i.e. all blocks are written in the order they are first encountered in the message and therefore necessary.
    so if we come across a string first, the entire first block will be strings.
    if we then encounter a nullable float, we will create a new block for floats.
    if we then encounter a custom scalar called Foo, we will create a new block for Foo (based on its type)
    */
  }

  maybeRewindToOverwriteNonNull = () => {
    // collapse labels over non-null markers, else we waste ~ 1byte/object
    if (this.buf.position > 0 && this.nonNullPos == this.buf.position - 1) { // non-null label is 1 byte long, since it is 0
      // console.log('overwriting non-null marker', this.nonNullPos)
      this.buf.incrementPosition(-1)
      this.nonNullPos = -1
    }
  }

  buildHeader(): Uint8Array {
    // TODO: support non-default flags
    const flags = new Uint8Array(1)
    this.track('flags', flags.toString(), flags.length)
    return flags
  }

  writeBytesRaw = (bytes: ArrayLike<number>): void => {
    this.buf.write(bytes)
    // console.log(this.pos, bytes)
    if (DEBUG) this.track('bytes', bytes, bytes.length)
  }

  writeVarInt = (n: Label | number): void => {
    this.maybeRewindToOverwriteNonNull()
    // console.log('writing', n, 'at', this.pos, VarInt.ZigZag.encode(n))
    if (DEBUG) this.track('varint', n, VarInt.ZigZag.encode(n).length)
    this.buf.write(VarInt.ZigZag.encode(n))
  }

  writeBytes = (bytes: ArrayLike<number>): void => {
    const posbefore = this.buf.position
    // console.log('writing bytes', bytes.length, bytes)
    this.writeVarInt(bytes.length)
    this.writeBytesRaw(bytes)
    // console.log('position change:', posbefore, '->', this.pos)
  }

  writeString = (str: string): void => {
    const bytes = CedarEncoder.utf8.encode(str)
    this.writeVarInt(bytes.length)
    this.buf.write(bytes)
    if (DEBUG) this.track('string', str, bytes.length)
    // return bytes
  }

  writeStringLength = (string: string, bytes: Uint8Array): void => {
    this.writeVarInt(bytes.length)
    if (DEBUG) this.track('string length', string, bytes.length)
  }

  writeLabel = (bytes: ArrayLike<number>): void => {
    // this.maybeRewindToOverwriteNonNull()
    this.writeBytesRaw(bytes)
  }

  makeWriter(t: Wire.Type): Writer<any> {
    switch (t.type) {
      case "STRING":
        return DeduplicatingWriter.lengthOfBytes(CedarEncoder.utf8encode)
      case "BYTES":
        return DeduplicatingWriter.lengthOfBytes(bytes => bytes)
      case "INT32":
        return BytesWriter.noLabel(VarInt.ZigZag.encode)

      case "ARRAY":
        return new DeduplicatingWriter<Array<any>>(
          (v: Array<any>, out: Uint8Array) => BigInt(v.length),
          (v: Array<any>) => { return null }
        )
      default:
        throw 'Unsupported dedupe type ' + t
    }
  }
  // /**
  //  * Builds a deduplicator for the given type.
  //  * 
  //  * @param t 
  //  * @returns 
  //  */
  // makeDeduper(t: Wire.Type): ValueDeduplicator<any> {
  //   switch (t.type) {
  //     case "STRING":
  //       return new ValueDeduplicator<string>(
  //         (string: string, bytes: Uint8Array): Uint8Array => {
  //           this.writeStringLength(string, bytes)
  //           return bytes
  //         },
  //         this.writeVarInt,
  //         (string: string) => CedarEncoder.utf8.encode(string)
  //       )

  //     case "BYTES":
  //       return new ValueDeduplicator<Uint8Array>(
  //         (bytes: Uint8Array, bytes2: Uint8Array): Uint8Array => {
  //           this.writeVarInt(bytes.length)
  //           return bytes
  //         },
  //         this.writeVarInt,
  //         bytes => bytes
  //       )

  //     case "INT32":
  //       return ValueRepeater.simple<number>(VarInt.ZigZag.encode)


  //     default:
  //       throw 'Unsupported dedupe type ' + t
  //   }
  // }

  write<T>(dedupeKey: Wire.DedupeKey | undefined, t: Wire.Type, v: T): Label | null {
    const writer = this.getWriter<T>(dedupeKey, t)
    const label = writer.write(v)
    if (label != null) { this.writeLabel(Label.encode(label)) }
    return label
  }

  private getWriter<T>(dedupeKey: Wire.DedupeKey | undefined, t: Wire.Type): Writer<T> {
    if (dedupeKey == null) { throw 'Programmer error: need deduplication key for ' + Wire.print(t) }
    let writer = this.writers.get(dedupeKey)
    if (writer == null) {
      writer = this.makeWriter(t)
      this.writers.set(dedupeKey, writer)
    }
    return writer
  }

  // stringDedup = this.newStringDeduplicator()
  // enumDedup = this.newStringDeduplicator()
  // idDedup = this.newStringDeduplicator()
  // objectTracker = new BackreferenceWriterTracker<object>()
  // listTracker = new BackreferenceWriterTracker<Array<unknown>>()
  // bytesDedup = new ValueDeduplicator<Uint8Array>(
  //   (v: Uint8Array) => this.writeBytes(v),
  //   this.writeVarInt,
  //   v => v
  // )

  jsToCedarWithType(js: any, wt: Wire.Type, encoder: CedarEncoder): void {
    const jsonify = (a: any) => JSON.stringify(a, (key, value) =>
      typeof value === Label.typeOf
        ? value.toString()
        : value // return everything else unchanged
      , 2)


    const result = this.writeCedar(js, wt, encoder)
    writeFileSync('/tmp/writelog.json', jsonify(this.tracked))
    // console.log('Read log', this.tracked)
    return result
  }

  /*
  examples:
  string: write length to msg, then bytes to value block
  int32: write nothing to msg, write zigzag varint to value block
  int32?: write non-null marker to msg, then zigzag varint to value block
  float64: write nothing to msg, then 8 bytes to value block
  float64?: write non-null marker to msg, then 8 bytes to value block
  [string?]: write array length to msg, then length of each entry to msg, then bytes for each entry to value block
  [string!]: write array length to msg, then length of each entry to msg, then bytes for each entry to value block
  [int32?]: write array length to msg, then non-null marker for each entry to msg, then zigzag for each entry to value block
  [int32!]: write array length to msg, then zigzag for each entry to value block
  */

  private writeCedar = (js: any, wt: Wire.Type, encoder: CedarEncoder, dedupeKey?: Wire.DedupeKey): void => {
    const log = (msg: string | object) => {
      encoder.log({ msg, wt, dedupeKey, js })
    }
    switch (wt.type) {
      case 'NULLABLE':
        if (js == null) {
          log('Writing null marker')
          encoder.writeLabel(Label.Null)
        }

        if (!Wire.isLabeled(wt.of)) {
          log('Writing non-null marker')
          encoder.writeLabel(Label.NonNull)
        }
        return this.writeCedar(js, wt.of, encoder, wt.dedupeKey)
      case 'DEDUPE':
        if (dedupeKey != null) { throw `Was already deduping '${dedupeKey}', unexpected to switch to '${wt.key}'. ${Wire.print(wt)}.` }
        return this.writeCedar(js, wt.of, encoder, wt.key)
      case 'RECORD': {

        /*
        // let nullMask = 0n
        // let i = 0
        // for (const { name, type } of wt.fields) {
        //   if (js && name in js && js[name] != null) {
        //   } else if (Wire.isNULLABLE(type)) {
        //     nullMask = BitSet.setBit(nullMask, i)
        //   }
        //   else {
        //     nullMask = BitSet.setBit(nullMask, i)
        //     // TODO: fragments which don't match a given union can return empty here even though it is non-nullable
        //     // this could be fixed up to detect this case, if we distinguished unions from other records
        //     //  console.log(js, wt); console.log(encoder.tracked); throw `Could not extract field ${name}\n\t${Wire.print(wt)}\n\t${JSON.stringify(js)}`
        //   }
        //   i++
        // }
        // log({ msg: 'Writing null mask', value: BitSet.writeVarBitSet(nullMask) })
        // if (nullMask == 0n) {
        //   encoder.writeLabelZero()
        // } else {
        //   encoder.writeBytes(BitSet.writeVarBitSet(nullMask))
        // }
        */

        for (const { name, type, omittable } of wt.fields) {
          // if (omittable) console.log('@ FOUND OMITTABLE', name, 'in', Wire.print(wt))
          if (js && name in js && js[name] != null) { // field actually present
            if (omittable && !Wire.isLabeled(type)) {
              this.track('writing omittable: present', name, 0)
              encoder.writeLabel(Label.NonNull)
            }
            log({ msg: 'Writing field', field: name, value: js[name] })
            this.writeCedar(js[name], type, encoder)
          } else if (omittable && js && (!(name in js) || js[name] === undefined)) { // field not present, but omittable
            this.track('writing omittable: absent', name, 0)
            encoder.writeLabel(Label.Absent)
          } else if (Wire.isNULLABLE(type)) {
            // this.track('writting null for field', name, 0)
            // encoder.log({ msg: 'Field was missing from object, writing NULL', field: name })
            // encoder.writeLabelNull()
            this.writeCedar(js[name], type, encoder)
          } else {
            // if (omittable) {
            //   this.track('writing omittable: absent', name, 0)
            //   encoder.writeLabelAbsent()
            // }
            this.track('skipping absent field', name, 0)
            throw 'programmer error'
            // encoder.writeLabelAbsent()
            // TODO: fragments which don't match a given union can return empty here even though it is non-nullable
            // this could be fixed up to detect this case, if we distinguished unions from other records
            // console.log(js, wt); console.log(encoder.tracked[encoder.tracked.length - 1]); throw `Could not extract field ${name}\n\t${wt}`
          }
        }
        return
      }
      case 'STRING':
      case 'BYTES':
      case 'INT32':
        log(`writing ${wt.type}}`)
        encoder.write(dedupeKey, wt, js)
        return
      // return encoder.dedup(dedupeKey, wt, js)
      case 'NULL': return // write nothing
      case 'BOOLEAN':
        encoder.log({ msg: 'Writing boolean', value: js })
        return encoder.writeLabel(js ? Label.True : Label.False)
      case 'FLOAT64':
        encoder.log({ msg: 'Writing float64', value: js })
        throw 'TODO not yet implemented'
      case 'FIXED':
        encoder.log({ msg: 'Writing fixed', length: wt.length, value: js })
        return encoder.writeBytesRaw(js) // TODO: check the fixed length
      case 'ARRAY': {
        encoder.log({ msg: 'Writing array', value: js })
        if (!Array.isArray(js)) {
          console.log(js, '\n\t', JSON.stringify(js), '\n\t', JSON.stringify(wt), '\n', Wire.print(wt))
          console.log(encoder.tracked)
          throw `Could not encode non - array as array: ${js} `
        }
        // write<T>(dedupeKey: Wire.DedupeKey | undefined, t: Wire.Type, v: T): Label | null {
        // const writer = encoder.getWriter(dedupeKey, wt)
        // const label = writer.write(js) // write length or backref
        // if (label && Label.isBackref(label)) { return } // don't write the array if we've seen it before
        encoder.writeVarInt(js.length)
        const t = wt.of
        return js.forEach(v => this.writeCedar(v, t, encoder))
      }
      case 'VARIANT':
        encoder.log({ msg: 'Writing variant', value: js })
        // return encoder.dedup(dedupeKey, wt, js)
        throw 'unexpected variant'
        return
      default: throw `Cannot yet handle wire type ${wt}`
    }
  }
}