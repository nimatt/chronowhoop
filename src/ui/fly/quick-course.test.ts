import { describe, expect, it } from 'vitest'
import { createQuickCourse, QUICK_SESSION_COURSE_NAME } from './quick-course'

describe('createQuickCourse', () => {
  it('builds a storage.md-shaped course from the setup fields', () => {
    const before = Date.now()
    const course = createQuickCourse('rtl', 4500)
    expect(course.name).toBe(QUICK_SESSION_COURSE_NAME)
    expect(course.direction).toBe('rtl')
    expect(course.minLapTimeMs).toBe(4500)
    expect(new Date(course.createdAt).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('mints a fresh id per course (each arm is a new ephemeral course)', () => {
    expect(createQuickCourse('ltr', 3000).id).not.toBe(createQuickCourse('ltr', 3000).id)
  })
})
