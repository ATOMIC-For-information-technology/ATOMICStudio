import { Component } from '@angular/core'

@Component({
  selector: 'app-inline-card',
  standalone: true,
  template: `
    <div class="inline-card" style="margin-top: 24px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc;">
      <h3 style="margin: 0 0 8px; color: #475569;">Inline Template Component</h3>
      <p style="margin: 0; color: #64748b; font-size: 14px;">This card demonstrates click-to-edit for templates defined directly inside .component.ts.</p>
    </div>
  `
})
export class InlineCardComponent {}
