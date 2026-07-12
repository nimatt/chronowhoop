import { registerSW } from 'virtual:pwa-register'

let updateAvailable = $state(false)

const updateSW = registerSW({
  onNeedRefresh() {
    updateAvailable = true
  },
})

export const swUpdate = {
  get available() {
    return updateAvailable
  },
  activate() {
    return updateSW(true)
  },
}
