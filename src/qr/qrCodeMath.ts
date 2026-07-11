export type Matrix = number[][]

export function reedSolomonGenerator(degree: number): number[] {
  const result = Array(degree).fill(0) as number[]
  result[degree - 1] = 1
  let root = 1
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < result.length; coefficient += 1) {
      result[coefficient] = gfMultiply(result[coefficient], root)
      if (coefficient + 1 < result.length) result[coefficient] ^= result[coefficient + 1]
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

export function reedSolomonRemainder(data: number[], generator: number[]): number[] {
  const result = Array(generator.length).fill(0) as number[]
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    for (let index = 0; index < generator.length; index += 1) result[index] ^= gfMultiply(generator[index], factor)
  }
  return result
}

export function appendBits(bits: number[], value: number, length: number): void {
  for (let index = length - 1; index >= 0; index -= 1) bits.push((value >>> index) & 1)
}

export function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

export function cloneMatrix(matrix: Matrix): Matrix {
  return matrix.map((row) => [...row])
}

function gfMultiply(left: number, right: number): number {
  let product = 0
  for (let index = 7; index >= 0; index -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d)
    product ^= ((right >>> index) & 1) * left
  }
  return product & 0xff
}
