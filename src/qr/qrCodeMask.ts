import { cloneMatrix, type Matrix } from './qrCodeMath.js'

export function applyBestMask(matrix: Matrix, functions: boolean[][]): { matrix: Matrix; mask: number } {
  let bestPenalty = Number.POSITIVE_INFINITY
  let bestMask = 0
  let bestMatrix = matrix

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = cloneMatrix(matrix)
    applyMask(candidate, functions, mask)
    const penalty = penaltyScore(candidate)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestMask = mask
      bestMatrix = candidate
    }
  }

  return { matrix: bestMatrix, mask: bestMask }
}

function applyMask(matrix: Matrix, functions: boolean[][], mask: number): void {
  for (let y = 0; y < matrix.length; y += 1) {
    for (let x = 0; x < matrix.length; x += 1) {
      if (functions[y][x] || !maskApplies(mask, x, y)) continue
      matrix[y][x] ^= 1
    }
  }
}

function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return (x * y) % 2 + (x * y) % 3 === 0
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0
    default: return false
  }
}

function penaltyScore(matrix: Matrix): number {
  return adjacentPenalty(matrix) + blockPenalty(matrix) + finderLikePenalty(matrix) + balancePenalty(matrix)
}

function adjacentPenalty(matrix: Matrix): number {
  let penalty = 0
  for (const row of matrix) penalty += lineAdjacentPenalty(row)
  for (let x = 0; x < matrix.length; x += 1) penalty += lineAdjacentPenalty(matrix.map((row) => row[x]))
  return penalty
}

function lineAdjacentPenalty(line: number[]): number {
  let penalty = 0
  let runColor = line[0]
  let runLength = 1
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === runColor) {
      runLength += 1
      if (runLength === 5) penalty += 3
      else if (runLength > 5) penalty += 1
    } else {
      runColor = line[index]
      runLength = 1
    }
  }
  return penalty
}

function blockPenalty(matrix: Matrix): number {
  let penalty = 0
  for (let y = 0; y < matrix.length - 1; y += 1) {
    for (let x = 0; x < matrix.length - 1; x += 1) {
      const color = matrix[y][x]
      if (matrix[y][x + 1] === color && matrix[y + 1][x] === color && matrix[y + 1][x + 1] === color) penalty += 3
    }
  }
  return penalty
}

function finderLikePenalty(matrix: Matrix): number {
  let penalty = 0
  for (const row of matrix) penalty += lineFinderLikePenalty(row)
  for (let x = 0; x < matrix.length; x += 1) penalty += lineFinderLikePenalty(matrix.map((row) => row[x]))
  return penalty
}

function lineFinderLikePenalty(line: number[]): number {
  let penalty = 0
  for (let index = 0; index <= line.length - 7; index += 1) {
    if (!matchesFinderPattern(line, index)) continue
    if (hasLightRun(line, index - 4, index) || hasLightRun(line, index + 7, index + 11)) penalty += 40
  }
  return penalty
}

function matchesFinderPattern(line: number[], offset: number): boolean {
  return (
    line[offset] === 1 &&
    line[offset + 1] === 0 &&
    line[offset + 2] === 1 &&
    line[offset + 3] === 1 &&
    line[offset + 4] === 1 &&
    line[offset + 5] === 0 &&
    line[offset + 6] === 1
  )
}

function hasLightRun(line: number[], start: number, end: number): boolean {
  if (start < 0 || end > line.length) return false
  for (let index = start; index < end; index += 1) {
    if (line[index] !== 0) return false
  }
  return true
}

function balancePenalty(matrix: Matrix): number {
  const total = matrix.length * matrix.length
  const dark = matrix.reduce((sum, row) => sum + row.filter((module) => module === 1).length, 0)
  return Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
}
