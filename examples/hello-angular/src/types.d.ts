declare module '@angular/core' {
  export interface Component {
    selector?: string
    standalone?: boolean
    imports?: any[]
    template?: string
    templateUrl?: string
    styleUrls?: string[]
    styles?: string[]
  }
  export function Component(options: Component): ClassDecorator
}

declare module '@angular/platform-browser' {
  export function bootstrapApplication(rootComponent: any, options?: any): Promise<any>
}

declare module 'zone.js'
