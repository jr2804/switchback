/**
 * The OpenCode side of the "does this decision model have a connection?" question.
 *
 * pi resolves `typesafe/jev-latest` or `ollama/tev1` from its model registry, so
 * an address without connection details is normal there. OpenCode publishes no
 * classifier catalog: the only way to classify is a `baseUrl` + `apiKey`, taken
 * from `decisionProviders.<provider>` or from a `decisionModels.<address>`
 * override. An address with neither cannot classify at all, and until this check
 * existed that showed up as "the router never classifies" with no explanation.
 *
 * The check belongs to this package (not core) precisely because it is a *host
 * capability* statement: core must not warn about something pi supports.
 *
 * Surface rule: the warning announces itself only where switchback is actually
 * used - the routing fan-out (router.ts, including the routing session on its
 * first route) and the command path. The boot/reload readers (index.ts
 * `readConfigOr`) deliberately omit it, or every host process in a fleet of
 * short-lived sessions would reprint it for conversations that never select a
 * switchback model.
 */

import { decisionModelsWithoutConnection } from "switchback-core/classifier-connection.ts";
import type { ResolvedSwitchbackFileConfig } from "switchback-core/types.ts";

/** One message per referenced decision model that has no usable endpoint. */
export function findUnconnectedDecisionModels(config: ResolvedSwitchbackFileConfig): string[] {
	return decisionModelsWithoutConnection(config).map((address) => {
		const provider = address.slice(0, address.indexOf("/"));
		return (
			`decision model "${address}" has no connection details and OpenCode has no classifier catalog - ` +
			`add decisionProviders.${provider} (baseUrl + apiKey) or switchback cannot classify through it`
		);
	});
}
