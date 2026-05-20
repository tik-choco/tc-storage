import { applyBestMask } from './qrCodeMask.js'
import { appendBits, bit, reedSolomonGenerator, reedSolomonRemainder, type Matrix } from './qrCodeMath.js'
import { lowErrorCorrectionBlocks, lowErrorCorrectionCodewords, totalCodewords } from './qrCodeTables.js'

export type QrCode = {
  modules: boolean[][]
  size: number
  version: number
}

const encoder = new TextEncoder()

export function createQrCode(value: string): QrCode {
  const data = encoder.encode(value)
  const version = chooseVersion(data.length)
  const dataCodewords = createDataCodewords(data, version)
  const codewords = addErrorCorrectionAndInterleave(dataCodewords, version)
  const base = createEmptyMatrix(version)
  const functions = createFunctionMatrix(version)

  drawFunctionPatterns(base, functions, version)
  drawCodewords(base, functions, codewords)

  const { matrix, mask } = applyBestMask(base, functions)
  drawFormatBits(matrix, functions, mask)

  return {
    modules: matrix.map((row) => row.map((module) => module === 1)),
    size: matrix.length,
    version,
  }
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= 40; version += 1) {
    const dataCapacityBits = getDataCodewordCount(version) * 8
    const requiredBits = 4 + characterCountBits(version) + byteLength * 8
    if (requiredBits <= dataCapacityBits) return version
  }
  throw new Error('Share URL is too long for a QR code')
}

function createDataCodewords(data: Uint8Array, version: number): number[] {
  const bitCapacity = getDataCodewordCount(version) * 8
  const bits: number[] = []
  appendBits(bits, 0b0100, 4)
  appendBits(bits, data.length, characterCountBits(version))
  for (const byte of data) appendBits(bits, byte, 8)
  appendBits(bits, 0, Math.min(4, bitCapacity - bits.length))
  appendBits(bits, 0, (8 - bits.length % 8) % 8)

  const codewords: number[] = []
  for (let offset = 0; offset < bits.length; offset += 8) {
    codewords.push(bits.slice(offset, offset + 8).reduce((value, bit) => (value << 1) | bit, 0))
  }

  for (let pad = 0xec; codewords.length < getDataCodewordCount(version); pad ^= 0xfd) {
    codewords.push(pad)
  }
  return codewords
}

function addErrorCorrectionAndInterleave(dataCodewords: number[], version: number): number[] {
  const blockCount = lowErrorCorrectionBlocks[version]
  const blockEccLength = lowErrorCorrectionCodewords[version]
  const rawCodewordCount = totalCodewords[version]
  const shortBlockCount = blockCount - rawCodewordCount % blockCount
  const shortBlockLength = Math.floor(rawCodewordCount / blockCount)
  const shortDataLength = shortBlockLength - blockEccLength
  const generator = reedSolomonGenerator(blockEccLength)
  const blocks: number[][] = []
  let dataOffset = 0

  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const dataLength = shortDataLength + (blockIndex < shortBlockCount ? 0 : 1)
    const data = dataCodewords.slice(dataOffset, dataOffset + dataLength)
    dataOffset += dataLength
    const ecc = reedSolomonRemainder(data, generator)
    if (blockIndex < shortBlockCount) data.push(0)
    blocks.push([...data, ...ecc])
  }

  const result: number[] = []
  for (let index = 0; index < blocks[0].length; index += 1) {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      if (index === shortDataLength && blockIndex < shortBlockCount) continue
      result.push(blocks[blockIndex][index])
    }
  }
  return result
}

function createEmptyMatrix(version: number): Matrix {
  const size = qrSize(version)
  return Array.from({ length: size }, () => Array(size).fill(-1) as number[])
}

function createFunctionMatrix(version: number): boolean[][] {
  const size = qrSize(version)
  return Array.from({ length: size }, () => Array(size).fill(false) as boolean[])
}

function drawFunctionPatterns(matrix: Matrix, functions: boolean[][], version: number): void {
  const size = matrix.length
  drawFinderPattern(matrix, functions, 3, 3)
  drawFinderPattern(matrix, functions, size - 4, 3)
  drawFinderPattern(matrix, functions, 3, size - 4)

  const positions = alignmentPatternPositions(version)
  for (const y of positions) {
    for (const x of positions) {
      if ((x === 6 && y === 6) || (x === 6 && y === size - 7) || (x === size - 7 && y === 6)) continue
      drawAlignmentPattern(matrix, functions, x, y)
    }
  }

  for (let index = 0; index < size; index += 1) {
    if (!functions[6][index]) setFunctionModule(matrix, functions, index, 6, index % 2 === 0)
    if (!functions[index][6]) setFunctionModule(matrix, functions, 6, index, index % 2 === 0)
  }

  drawFormatBits(matrix, functions, 0)
  drawVersionBits(matrix, functions, version)
}

function drawFinderPattern(matrix: Matrix, functions: boolean[][], centerX: number, centerY: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = centerX + dx
      const y = centerY + dy
      if (x < 0 || y < 0 || x >= matrix.length || y >= matrix.length) continue
      const distance = Math.max(Math.abs(dx), Math.abs(dy))
      setFunctionModule(matrix, functions, x, y, distance !== 2 && distance !== 4)
    }
  }
}

function drawAlignmentPattern(matrix: Matrix, functions: boolean[][], centerX: number, centerY: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      setFunctionModule(matrix, functions, centerX + dx, centerY + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

function drawFormatBits(matrix: Matrix, functions: boolean[][], mask: number): void {
  const size = matrix.length
  const bits = formatBits(mask)
  for (let index = 0; index <= 5; index += 1) setFunctionModule(matrix, functions, 8, index, bit(bits, index))
  setFunctionModule(matrix, functions, 8, 7, bit(bits, 6))
  setFunctionModule(matrix, functions, 8, 8, bit(bits, 7))
  setFunctionModule(matrix, functions, 7, 8, bit(bits, 8))
  for (let index = 9; index < 15; index += 1) setFunctionModule(matrix, functions, 14 - index, 8, bit(bits, index))
  for (let index = 0; index < 8; index += 1) setFunctionModule(matrix, functions, size - 1 - index, 8, bit(bits, index))
  for (let index = 8; index < 15; index += 1) setFunctionModule(matrix, functions, 8, size - 15 + index, bit(bits, index))
  setFunctionModule(matrix, functions, 8, size - 8, true)
}

function drawVersionBits(matrix: Matrix, functions: boolean[][], version: number): void {
  if (version < 7) return
  const size = matrix.length
  let remainder = version
  for (let index = 0; index < 12; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25)
  }
  const bits = (version << 12) | remainder
  for (let index = 0; index < 18; index += 1) {
    const x = size - 11 + index % 3
    const y = Math.floor(index / 3)
    const dark = bit(bits, index)
    setFunctionModule(matrix, functions, x, y, dark)
    setFunctionModule(matrix, functions, y, x, dark)
  }
}

function drawCodewords(matrix: Matrix, functions: boolean[][], codewords: number[]): void {
  const size = matrix.length
  let bitIndex = 0
  let upward = true

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical
      for (let column = 0; column < 2; column += 1) {
        const x = right - column
        if (functions[y][x]) continue
        const byte = codewords[Math.floor(bitIndex / 8)] ?? 0
        matrix[y][x] = bit(byte, 7 - bitIndex % 8) ? 1 : 0
        bitIndex += 1
      }
    }
    upward = !upward
  }
}

function setFunctionModule(matrix: Matrix, functions: boolean[][], x: number, y: number, dark: boolean): void {
  matrix[y][x] = dark ? 1 : 0
  functions[y][x] = true
}

function alignmentPatternPositions(version: number): number[] {
  if (version === 1) return []
  const size = qrSize(version)
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const positions = [6]
  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position)
  }
  return positions
}

function formatBits(mask: number): number {
  const errorCorrectionFormatBits = 1
  const data = (errorCorrectionFormatBits << 3) | mask
  let remainder = data
  for (let index = 0; index < 10; index += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537)
  }
  return ((data << 10) | remainder) ^ 0x5412
}

function characterCountBits(version: number): number {
  return version < 10 ? 8 : 16
}

function getDataCodewordCount(version: number): number {
  return totalCodewords[version] - lowErrorCorrectionCodewords[version] * lowErrorCorrectionBlocks[version]
}

function qrSize(version: number): number {
  return version * 4 + 17
}
