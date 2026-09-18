import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * Without this, one thrown render leaves a blank white page: React unmounts
 * the tree and the reader gets no message, no cause and no way back. A
 * malformed export producing an unexpected shape should cost a sentence, not
 * the whole app.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Nothing is reported anywhere — no analytics, no error service — so the
    // console is the only place this exists. That is the privacy trade.
    console.error('Loose Ends failed to render', error, info.componentStack)
  }

  render() {
    if (!this.state.failed) return this.props.children

    return (
      <main className="page">
        <header className="masthead">
          <h1>Loose Ends</h1>
        </header>
        <section className="intake">
          <h2>Something went wrong</h2>
          <p className="note">
            The page hit an error it could not recover from. Nothing was sent
            anywhere and nothing was saved &mdash; reloading starts fresh.
          </p>
          <p className="note">
            If it happens again with the same export, that file is probably the
            cause, and it would be useful to know about:{' '}
            <a
              href="https://github.com/Karska-dev/LooseEnds/issues"
              target="_blank"
              rel="noopener noreferrer"
            >
              open an issue
            </a>
            . Please don&rsquo;t attach the export itself &mdash; it is your
            whole reading history.
          </p>
          <div className="actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </section>
      </main>
    )
  }
}
