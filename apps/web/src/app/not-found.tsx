import Link from "next/link";
import { StatePanel } from "@abos/ui";

export default function NotFound() {
  return (
    <StatePanel kind="empty" title="Workspace not found" description="This page does not exist or is not available to you.">
      <Link className="secondary-button" href="/">Return to overview</Link>
    </StatePanel>
  );
}
