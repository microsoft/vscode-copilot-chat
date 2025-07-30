/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CopilotUserQuotaInfo } from '../../chat/common/chatQuotaService';

/**
 * A function used to determine if the org list contains an internal organization
 * @param orgList The list of organizations the user is a member of
 * Whether or not it contains an internal org
 */
export function containsInternalOrg(orgList: string[]): boolean {
	// Certain feature right now is limited to a set of allowed organization only (i.e. internal telemetry)
	// These IDs map to ['Github', 'Microsoft', 'ms-copilot', 'gh-msft-innersource', 'microsoft']
	const ALLOWED_ORGANIZATIONS = ['4535c7beffc844b46bb1ed4aa04d759a', 'a5db0bcaae94032fe715fb34a5e4bce2', '7184f66dfcee98cb5f08a1cb936d5225',
		'1cb18ac6eedd49b43d74a1c5beb0b955', 'ea9395b9a9248c05ee6847cbd24355ed'];
	// Check if the user is part of an allowed organization.
	for (const org of orgList) {
		if (ALLOWED_ORGANIZATIONS.includes(org)) {
			return true;
		}
	}
	return false;
}

export class CopilotToken {
	private readonly tokenMap: Map<string, string>;
	constructor(private readonly _info: ExtendedTokenInfo) {
		this.tokenMap = this.parseToken(_info.token);
	}

	private parseToken(token: string): Map<string, string> {
		const result = new Map<string, string>();
		const firstPart = token?.split(':')[0];
		const fields = firstPart?.split(';');
		for (const field of fields) {
			const [key, value] = field.split('=');
			result.set(key, value);
		}
		return result;
	}

	get token(): string {
		return this._info.token;
	}

	get sku(): string | undefined {
		return this._info.sku;
	}

	/**
	 * Evaluates `has_cfi_access?` which is defined as `!has_cfb_access? && !has_cfe_access?`
	 * (cfb = copilot for business, cfe = copilot for enterprise).
	 * So it's also true for copilot free users.
	 */
	get isIndividual(): boolean {
		return this._info.individual ?? false;
	}

	get organizationList(): string[] {
		return this._info.organization_list || [];
	}

	get enterpriseList(): number[] {
		return this._info.enterprise_list || [];
	}

	get endpoints(): { api: string; telemetry: string; proxy: string; 'origin-tracker'?: string } | undefined {
		return this._info.endpoints;
	}

	get isInternal() {
		return containsInternalOrg(this.organizationList);
	}

	get isFreeUser(): boolean {
		return this.sku === 'free_limited_copilot';
	}

	get isChatQuotaExceeded(): boolean {
		return this.isFreeUser && (this._info.limited_user_quotas?.chat ?? 1) <= 0;
	}

	get isCompletionsQuotaExceeded(): boolean {
		return this.isFreeUser && (this._info.limited_user_quotas?.completions ?? 1) <= 0;
	}

	get isVscodeTeamMember(): boolean {
		return this._info.isVscodeTeamMember;
	}

	get copilotPlan(): 'free' | 'individual' | 'individual_pro' | 'business' | 'enterprise' {
		if (this.isFreeUser) {
			return 'free';
		}
		const plan = this._info.copilot_plan;
		switch (plan) {
			case 'individual':
			case 'individual_pro':
			case 'business':
			case 'enterprise':
				return plan;
			default:
				// Default to 'individual' for unexpected values
				return 'individual';
		}
	}

	get quotaInfo() {
		return { quota_snapshots: this._info.quota_snapshots, quota_reset_date: this._info.quota_reset_date };
	}

	get username(): string {
		return this._info.username;
	}

	private _isTelemetryEnabled: boolean | undefined;
	isTelemetryEnabled(): boolean {
		if (this._isTelemetryEnabled === undefined) {
			this._isTelemetryEnabled = this._info.telemetry === 'enabled';
		}
		return this._isTelemetryEnabled;
	}

	private _isPublicSuggestionsEnabled: boolean | undefined;
	isPublicSuggestionsEnabled(): boolean {
		if (this._isPublicSuggestionsEnabled === undefined) {
			this._isPublicSuggestionsEnabled = this._info.public_suggestions === 'enabled';
		}
		return this._isPublicSuggestionsEnabled;
	}

	isChatEnabled(): boolean {
		return this._info.chat_enabled ?? false;
	}

	isCopilotIgnoreEnabled(): boolean {
		return this._info.copilotignore_enabled ?? false;
	}

	get isCopilotCodeReviewEnabled(): boolean {
		return (this.getTokenValue('ccr') === '1');
	}

	isEditorPreviewFeaturesEnabled(): boolean {
		// Editor preview features are disabled if the flag is present and set to 0
		return this.getTokenValue('editor_preview_features') !== '0';
	}

	isMcpEnabled(): boolean {
		// MCP is disabled if the flag is present and set to 0
		return this.getTokenValue('mcp') !== '0';
	}

	getTokenValue(key: string): string | undefined {
		return this.tokenMap.get(key);
	}

	isExpandedClientSideIndexingEnabled(): boolean {
		return this._info.blackbird_clientside_indexing === true;
	}
}

/**
 * Details of the user's telemetry consent status we get from the server during token retrieval.
 *
 * `unconfigured` is a transitional state for pre-GA that indicates the user is in the Technical Preview
 * and needs to be asked about telemetry consent client-side. It can be removed post-GA as the server
 * will never return it again.
 *
 * `enabled` indicates that they agreed to full telemetry.
 *
 * `disabled` indicates that they opted out of full telemetry so we can only send the core messages
 * that users cannot opt-out of.
 *
 */
export type UserTelemetryChoice = 'enabled' | 'disabled';
/**
 * A notification we get from the server during token retrieval. Needs to be presented to the user.
 */
type ServerSideNotification = {
	message: string;
	url: string;
	title: string;
};
/**
 * A notification that warns the user about upcoming problems.
 */
type WarningNotification = ServerSideNotification & {
	notification_id: string;
};
/**
 * A notification in case of an error.
 */
type ErrorNotification = ServerSideNotification;
/**
 * A server response containing a Copilot token and metadata associated with it.
 */
export interface TokenInfo {
	// v2 format: fields:mac
	//   fields are ';' separated key=value pairs, including tid (tracking_id), dom (domain), and exp (unix_time).
	token: string;
	expires_at: number; // unix time UTC in seconds
	refresh_in: number; // seconds to refresh token
	user_notification?: WarningNotification;
	error_details?: ErrorNotification;
	organization_list?: string[];
	code_quote_enabled?: boolean;
	public_suggestions?: string;
	telemetry?: string;
	copilotignore_enabled?: boolean;
	endpoints?: { api: string; telemetry: string; proxy: string; 'origin-tracker'?: string };
	chat_enabled?: boolean;
	limited_user_quotas?: { chat: number; completions: number };
	enterprise_list?: number[];
	individual?: boolean;
	sku?: string; // e.g. 'copilot_enterprise_seat'
	message?: string; // error message
}

/**
 * A server response containing the user info for the copilot user from the /copilot_internal/user endpoint
 */

export interface CopilotUserInfo extends CopilotUserQuotaInfo {
	access_type_sku: string;
	analytics_tracking_id: string;
	assigned_date: string;
	can_signup_for_limited: boolean;
	chat_enabled: boolean;
	copilot_plan: string;
	organization_login_list: string[];
	organization_list: Array<{
		login: string;
		name: string | null;
	}>;
}

// The token info extended with additional metadata that is helpful to have
export type ExtendedTokenInfo = TokenInfo & { username: string; isVscodeTeamMember: boolean; blackbird_clientside_indexing?: boolean } & Pick<CopilotUserInfo, 'copilot_plan' | 'quota_snapshots' | 'quota_reset_date'>;

export type TokenEnvelope = Omit<TokenInfo, 'token' | 'organization_list'>;

export type TokenErrorReason = 'NotAuthorized' | 'FailedToGetToken' | 'TokenInvalid' | 'GitHubLoginFailed' | 'HTTP401' | 'RateLimited';

export enum TokenErrorNotificationId {
	EnterPriseManagedUserAccount = 'enterprise_managed_user_account',
	NotSignedUp = 'not_signed_up',
	NoCopilotAccess = 'no_copilot_access',
	SubscriptionEnded = 'subscription_ended',
	ServerError = 'server_error',
	FeatureFlagBlocked = 'feature_flag_blocked',
	SpammyUser = 'spammy_user',
	CodespacesDemoInactive = 'codespaces_demo_inactive', //TODO: Handle this if this is still applicable
	SnippyNotConfigured = 'snippy_not_configured'
}

export type TokenError = {
	reason: TokenErrorReason;
	notification_id?: TokenErrorNotificationId;
	message?: string; // TODO: not used yet, but will be for 466 errors
};

export type TokenInfoOrError = ({ kind: 'success' } & ExtendedTokenInfo) | ({ kind: 'failure' } & TokenError);
