import Link from "next/link";
import { StatePanel } from "@abos/ui";

export default function NotFound() {
  return (
    <StatePanel kind="empty" title="Workspace not found" description="This route is not part of the approved Stage 0 screen inventory.">
      <Link className="secondary-button" href="/">Return to overview</Link>
    </StatePanel>
  );
}
