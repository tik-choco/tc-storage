import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFolderRoutePath, readFolderRoute, removeFolderRouteFromUrl } from '../src/folderRoute.js'

const uuid = '4c722219-f4ec-47fe-93ef-77ce56c703fc'
const folderId = `folder-${uuid}`

test('readFolderRoute reads a folder id from the current query string', () => {
  assert.equal(readFolderRoute(`?folder=${uuid}`), folderId)
  assert.equal(readFolderRoute(`?folder=${folderId}`), folderId)
  assert.equal(readFolderRoute('?view=grid&folder=legacy-folder'), 'legacy-folder')
  assert.equal(readFolderRoute('?folder='), null)
  assert.equal(readFolderRoute('?view=grid'), null)
})

test('buildFolderRoutePath preserves unrelated URL state', () => {
  assert.equal(
    buildFolderRoutePath(folderId, 'https://app.example/storage?view=grid#preview'),
    `/storage?view=grid&folder=${uuid}#preview`,
  )
  assert.equal(
    buildFolderRoutePath(null, `https://app.example/storage?view=grid&folder=${uuid}#preview`),
    '/storage?view=grid#preview',
  )
})

test('removeFolderRouteFromUrl keeps share URLs independent from local navigation', () => {
  assert.equal(
    removeFolderRouteFromUrl(`https://app.example/storage?folder=${uuid}&view=grid#tc-share=abc`),
    'https://app.example/storage?view=grid#tc-share=abc',
  )
})
