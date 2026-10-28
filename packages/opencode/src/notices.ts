/**
 * Where a notice goes.
 *
 * The server plugin can only write into the transcript (`session.synthetic`),
 * which is the wrong surface for a transient event like "switched to X" when a
 * client has a real toast. This module is the switch: while at least one client
 * has attached over the `switchback` RPC, notices go to that client; otherwise
 * they fall back to the transcript so headless runs still report what happened.
 *
 * Deliberately host-free and dependency-free: a counter, a publish hook, and a
 * boolean answer. The RPC handlers, the router and the commands all read it,
 * and tests drive it without any host at all.
 */

import type { Notice, NoticeVariant } from "./rpc.ts";

type Emit = (notice: Notice) => void;

let emit: Emit | undefined;
let attached = 0;

/** Install (or clear) the transport that carries notices to attached clients. */
export function setNoticeChannel(next: Emit | undefined): void {
	emit = next;
}

/** A client attached its notice sink. Returns the new attachment count. */
export function attachNoticeSink(): number {
	attached += 1;
	return attached;
}

/** A client released its sink. Never drops below zero. */
export function detachNoticeSink(): number {
	attached = Math.max(0, attached - 1);
	return attached;
}

/** How many clients are currently listening. */
export function noticeSinkCount(): number {
	return attached;
}

/** Reset every piece of module state (plugin dispose and tests). */
export function resetNoticeChannel(): void {
	emit = undefined;
	attached = 0;
}

/**
 * Deliver one notice. Returns true when a client sink took it; false when
 * nothing is listening and the caller should use its own fallback channel.
 * Never throws: a broken sink must not fail a routing decision.
 */
export function publishNotice(notice: {
	readonly sessionID?: string;
	readonly message: string;
	readonly variant: NoticeVariant;
}): boolean {
	if (attached === 0 || emit === undefined) return false;
	try {
		emit(notice);
		return true;
	} catch {
		return false;
	}
}
