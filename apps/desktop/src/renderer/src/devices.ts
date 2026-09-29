// Logical device sizes for the multi-device preview canvas (CSS pixels).
export interface Device {
  id: string
  label: string
  width: number
  height: number
  kind: 'phone' | 'tablet' | 'desktop'
}

export const DEVICES: Device[] = [
  { id: 'iphone', label: 'iPhone', width: 390, height: 844, kind: 'phone' },
  { id: 'ipad', label: 'iPad', width: 820, height: 1180, kind: 'tablet' },
  { id: 'desktop', label: 'Desktop', width: 1280, height: 800, kind: 'desktop' }
]
