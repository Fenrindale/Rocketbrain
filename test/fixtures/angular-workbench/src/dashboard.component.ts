import {Component, EventEmitter, Input, Output} from '@angular/core';

@Component({
  selector: 'rb-count',
  standalone: true,
  template: '{{ displayed }}',
})
export class CountComponent {
  @Input('currentValue') displayed = 0;
  @Output() sent = new EventEmitter<number>();
}

@Component({
  selector: 'rb-dashboard',
  standalone: true,
  imports: [CountComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent {
  readonly model = {people: 2, departments: [{id: 1, title: 'platform'}]};
  readonly wrong = 'invalid count';
  receive(value: number) { return value > 0; }
}

@Component({selector: 'rb-inline', standalone: true, template: '<h2>{{ title }}</h2>'})
export class InlineComponent {
  title = 'Direct Angular template';
}
