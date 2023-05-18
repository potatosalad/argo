import { BufRead } from './buf'
import { Label, LabelKind } from './label'

export abstract class BlockReader<Out> {
  constructor(public buf: BufRead) { }
  abstract read(parent: BufRead): Out | undefined | null
}

export class LabelBlockReader<Out> extends BlockReader<Out> {
  constructor(public buf: BufRead, protected fromBytes: (bytes: Uint8Array) => Out) { super(buf) }

  read(parent: BufRead): Out | undefined | null {
    const label = Label.read(parent)

    switch (Label.kind(label)) {
      case LabelKind.Backreference: throw 'Programmer error: This type must not use backreferences'
      case LabelKind.Length: return this.fromBytes(this.buf.read(Number(label)))
      case LabelKind.Null: throw 'Programmer error: Reader cannot handle null labels'
      case LabelKind.Absent: return undefined
      case LabelKind.Error: return null
    }
  }
}

export class DeduplicatingLabelBlockReader<Out> extends BlockReader<Out> {
  values: Out[] = []
  constructor(public buf: BufRead, protected fromBytes: (bytes: Uint8Array) => Out) { super(buf) }

  read(parent: BufRead): Out {
    const label = Label.read(parent)

    switch (Label.kind(label)) {
      case LabelKind.Backreference: {
        const value = this.values[Label.labelToOffset(label)]
        if (value == undefined) {
          throw 'Got invalid backreference'
        }
        return value
      }
      case LabelKind.Length:
        const bytes = this.buf.read(Number(label))
        const value = this.fromBytes(bytes)
        this.values.push(value)
        return value
      case LabelKind.Null:
        throw 'Programmer error: Reader cannot handle null labels'
      case LabelKind.Absent: throw 'Programmer error: Reader cannot handle absent labels'
      case LabelKind.Error: throw 'Programmer error: Reader cannot handle error labels'
    }
  }
}

export class FixedSizeBlockReader<Out> extends BlockReader<Out> {
  constructor(public buf: BufRead, protected fromBytes: (bytes: Uint8Array) => Out, readonly byteLength: number) {
    super(buf)
  }

  read(parent: BufRead): Out {
    return this.fromBytes(this.buf.read(this.byteLength))
  }
}

export class UnlabeledVarIntBlockReader extends BlockReader<number> {
  read(parent: BufRead): number {
    return Number(Label.read(this.buf))
  }
}