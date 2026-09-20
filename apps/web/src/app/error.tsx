"use client";

import { StatePanel } from "@abos/ui";

export default function GlobalError({ reset }: { readonly error: Error & { digest?: string }; readonly reset: () => void }) {
  return (
    <StatePanel kind="error" title="The workspace could not be displayed" description="No transaction was submitted. Retry the screen or contact support if the problem persists.">
      <button className="secondary-button" type="button" onClick={reset}>Try again</button>
    </StatePanel>
  );
}
