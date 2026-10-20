import { Component } from '@angular/core'
import { InlineCardComponent } from './inline-card.component'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [InlineCardComponent],
  templateUrl: './app.component.html',
  styleUrls: []
})
export class AppComponent {
  count = 0

  increment(): void {
    this.count++
  }
}
