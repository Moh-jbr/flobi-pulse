// One bad field (an object where the UI expects text) used to blank the whole window:
// React unmounts everything when a render throws and nothing catches it. This keeps the
// damage to the page or panel it happened in, with a way to try again.
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ui] render failed:', error, info?.componentStack || '');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="h-full grid place-items-center p-8">
        <div className="max-w-[420px] text-center">
          <div className="text-headline font-semibold">{this.props.what ? `This ${this.props.what} couldn’t be shown` : 'Something went wrong here'}</div>
          <div className="text-callout text-label-2 mt-1 break-words selectable">{String(this.state.error?.message || this.state.error)}</div>
          <button type="button" className="mt-3 text-callout text-accent" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
