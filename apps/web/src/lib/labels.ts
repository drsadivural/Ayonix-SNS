// Plain-language labels. Every status shown in the UI has a text label;
// colour/tone is an additional cue, never the only one.
import type { ConnectionState, Platform, PlanName, PostFormat, Role, SubscriptionStatus, TargetState } from '@ayonix/contracts';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const PLATFORM_LABELS: Record<Platform, string> = {
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

export const PLATFORM_DESCRIPTIONS: Record<Platform, string> = {
  linkedin: 'Page / member publishing',
  facebook: 'Pages publishing',
  instagram: 'Professional account',
  tiktok: 'Creator consent per post',
  youtube: 'Video uploads and metrics',
};

export const FORMAT_LABELS: Record<PostFormat, string> = {
  text: 'Text',
  link: 'Link',
  image: 'Image',
  video: 'Video',
  reel: 'Reel',
  carousel: 'Carousel',
  photo: 'Photo',
};

export const TARGET_STATE_INFO: Record<TargetState, { label: string; tone: Tone; description: string }> = {
  draft: { label: 'Draft', tone: 'neutral', description: 'Not scheduled. Nothing will be published until it is previewed and confirmed.' },
  awaiting_approval: { label: 'Needs approval', tone: 'warning', description: 'Waiting for the required approval before it can be published.' },
  scheduled: { label: 'Scheduled', tone: 'info', description: 'Booked for the chosen time. A publication is reserved from this cycle.' },
  queued: { label: 'Queued', tone: 'info', description: 'Due now and waiting its turn to be sent to the network.' },
  submitting: { label: 'Uploading', tone: 'info', description: 'Being sent to the network now.' },
  processing: { label: 'Processing', tone: 'info', description: 'The network accepted the upload and is processing it. Processing is not published.' },
  published: { label: 'Published', tone: 'success', description: 'The network confirmed the post is live.' },
  retry_wait: { label: 'Waiting to retry', tone: 'warning', description: 'A temporary problem occurred. Ayonix will retry automatically.' },
  reconnect_required: { label: 'Reconnect needed', tone: 'danger', description: 'The account connection expired or lost permission. Reconnect it in Connectors.' },
  failed: { label: 'Failed', tone: 'danger', description: 'Publishing did not succeed. The reserved publication was released.' },
  outcome_unknown: { label: 'Outcome unknown', tone: 'danger', description: 'The network may have published this. Do not retry blindly; check the account first.' },
  canceled: { label: 'Canceled', tone: 'neutral', description: 'Canceled before publishing.' },
};

export const ATTENTION_STATES: readonly TargetState[] = ['awaiting_approval', 'failed', 'outcome_unknown', 'reconnect_required'];

export const CONNECTION_STATE_INFO: Record<ConnectionState, { label: string; tone: Tone }> = {
  disconnected: { label: 'Not connected', tone: 'neutral' },
  authorizing: { label: 'Authorizing', tone: 'info' },
  pending_review: { label: 'Review pending', tone: 'warning' },
  connected: { label: 'Connected', tone: 'success' },
  expiring: { label: 'Expiring soon', tone: 'warning' },
  reconnect_required: { label: 'Reconnect required', tone: 'danger' },
  restricted: { label: 'Restricted', tone: 'warning' },
  error: { label: 'Error', tone: 'danger' },
};

export const CAPABILITY_STATUS_INFO: Record<'available' | 'pending_review' | 'unavailable', { label: string; tone: Tone }> = {
  available: { label: 'Available', tone: 'success' },
  pending_review: { label: 'Pending review', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
};

export const SUBSCRIPTION_STATUS_INFO: Record<SubscriptionStatus, { label: string; tone: Tone }> = {
  none: { label: 'No plan', tone: 'neutral' },
  trialing: { label: 'Trial', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  past_due: { label: 'Payment failed', tone: 'danger' },
  suspended: { label: 'Suspended', tone: 'danger' },
  unpaid: { label: 'Unpaid', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  incomplete: { label: 'Awaiting payment confirmation', tone: 'warning' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export const PLAN_LABELS: Record<PlanName, string> = {
  trial: 'Website trial',
  basic: 'Basic',
  standard: 'Standard',
  premium: 'Premium',
  custom: 'Custom',
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  viewer: 'Viewer',
};

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export function atLeast(role: Role | undefined | null, min: Role): boolean {
  return role ? RANK[role] >= RANK[min] : false;
}

export const TIKTOK_PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (followers you follow back)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me',
};

export function tiktokPrivacyLabel(value: string): string {
  return TIKTOK_PRIVACY_LABELS[value] ?? value.toLowerCase().replace(/_/g, ' ');
}

export const NOTIFICATION_LABELS: Record<string, { label: string; description: string }> = {
  publish_failed: { label: 'Publishing failures', description: 'A post failed or its outcome is unknown.' },
  approval_needed: { label: 'Approvals needed', description: 'A TikTok post needs creator approval.' },
  reconnect_required: { label: 'Reconnect required', description: 'An account connection needs attention.' },
  payment_failed: { label: 'Payment failures', description: 'A subscription payment failed.' },
  weekly_report: { label: 'Weekly report', description: 'A weekly summary of publishing activity.' },
};

export const CANCEL_OUTCOME_LABELS: Record<string, string> = {
  canceled: 'Canceled. The reserved publication was released.',
  already_published: 'Already published. It stays live on the network.',
  already_terminal: 'Already finished (failed or canceled earlier). Nothing changed.',
  submitted_reconciling: 'Already sent to the network, so it may already be published. Ayonix is checking the outcome.',
  native_cancel_requested: 'Uploaded with the network’s own schedule. Ayonix asked the network to remove it; check back shortly.',
};

export const RESEARCH_KIND_LABELS: Record<'auto_learn' | 'competitor_check' | 'similar_research', string> = {
  auto_learn: 'Auto learn',
  competitor_check: 'Competitor check',
  similar_research: 'Similar-product research',
};

export const JOB_STATUS_INFO: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  ready: { label: 'Ready', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  blocked: { label: 'Blocked', tone: 'warning' },
  canceled: { label: 'Canceled', tone: 'neutral' },
  deleted: { label: 'Deleted', tone: 'neutral' },
};

export function jobStatus(status: string): { label: string; tone: Tone } {
  return JOB_STATUS_INFO[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' };
}
