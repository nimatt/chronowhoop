import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import App from '../App.svelte'
import type { CapabilityReport } from '../../core/capabilities/capabilities'
import { MemoryStorage } from '../../core/storage/memory-storage'
import { makeCourse } from '../../core/storage/storage-contract'

const passingReport: CapabilityReport = {
  ok: true,
  capabilities: [
    { name: 'webcodecs', label: 'WebCodecs capture (MediaStreamTrackProcessor)', ok: true },
    { name: 'camera', label: 'Camera (getUserMedia)', ok: true },
    { name: 'opfs', label: 'Local storage (OPFS)', ok: true },
    { name: 'speech', label: 'Speech synthesis', ok: true },
  ],
}

let container: HTMLElement
let instance: ReturnType<typeof mount> | undefined

const text = () => container.textContent ?? ''
const waitForText = (needle: string) => vi.waitFor(() => expect(text()).toContain(needle))

function mountApp(storage: MemoryStorage) {
  instance = mount(App, {
    target: container,
    props: {
      check: () => Promise.resolve(passingReport),
      createStorage: () => storage,
    },
  })
}

function linkByText(label: string): HTMLAnchorElement {
  const link = Array.from(container.querySelectorAll('a')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!link) throw new Error(`no link labelled ${JSON.stringify(label)}`)
  return link
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`no button labelled ${JSON.stringify(label)}`)
  return button
}

function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector)
  if (!element) throw new Error(`no element matching ${selector}`)
  return element
}

function setInputValue(input: HTMLInputElement, value: string) {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeEach(() => {
  history.replaceState(null, '', location.pathname + location.search)
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (instance) {
    void unmount(instance)
    instance = undefined
  }
  container.remove()
})

describe('course CRUD flow (App + MemoryStorage)', () => {
  it('creates a course via the form, lists it on Home, and opens the course view shell', async () => {
    mountApp(new MemoryStorage())

    // Empty state on a fresh storage.
    await waitForText('create your first course')

    // Real anchor navigation: hash → route → CourseForm.
    linkByText('New course').click()
    await waitForText('Minimum lap time')

    setInputValue(query('input[type="text"]'), 'Basement 3-gate')
    setSelectValue(query('select'), 'rtl')
    setInputValue(query('input[type="number"]'), '4.5')
    await vi.waitFor(() => expect(buttonByText('Save').disabled).toBe(false))
    buttonByText('Save').click()

    // Save navigates to the course view shell.
    await waitForText('Sessions')
    expect(text()).toContain('Basement 3-gate')
    expect(text()).toContain('right → left')
    expect(text()).toContain('min lap 4.5 s')
    expect(location.hash).toMatch(/^#\/course\/[0-9a-f-]+$/)

    // Home lists the course with a per-course Fly affordance.
    linkByText('Courses').click()
    await waitForText('Basement 3-gate')
    expect(text()).not.toContain('create your first course')
    const flyLink = linkByText('Fly')
    expect(flyLink.getAttribute('href')).toMatch(/^#\/fly\/[0-9a-f-]+$/)
  })

  it('edits an existing course and rejects an empty name', async () => {
    const storage = new MemoryStorage()
    const course = makeCourse({ id: 'c-1', name: 'Old name', direction: 'ltr', minLapTimeMs: 3000 })
    await storage.saveCourses({ courses: [course], settings: { speechEnabled: true } })
    mountApp(storage)

    await waitForText('Old name')
    location.hash = '#/course/c-1'
    await waitForText('Sessions')

    linkByText('Edit').click()
    await waitForText('Edit course')
    const nameInput = query<HTMLInputElement>('input[type="text"]')
    expect(nameInput.value).toBe('Old name')

    // Empty name blocks saving.
    setInputValue(nameInput, '   ')
    await waitForText('A name is required.')
    expect(buttonByText('Save').disabled).toBe(true)

    setInputValue(nameInput, 'New name')
    await vi.waitFor(() => expect(buttonByText('Save').disabled).toBe(false))
    buttonByText('Save').click()

    await waitForText('Sessions')
    expect(location.hash).toBe('#/course/c-1')
    expect(text()).toContain('New name')

    // The edit persisted through the storage seam.
    const { courses } = await storage.loadCourses()
    expect(courses).toEqual([{ ...course, name: 'New name' }])
  })

  it('shows a not-found message for a course view on an unknown id', async () => {
    mountApp(new MemoryStorage())
    await waitForText('create your first course')

    location.hash = '#/course/does-not-exist'
    await waitForText('This course does not exist.')
  })
})
