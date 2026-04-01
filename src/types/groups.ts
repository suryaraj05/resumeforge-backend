export type GroupMemberRole = 'admin' | 'member';

export interface GroupMember {
  userId: string;
  role: GroupMemberRole;
  joinedAt: string;
}

export interface GroupDoc {
  groupId: string;
  name: string;
  createdBy: string;
  members: GroupMember[];
  createdAt: string;
}

export type NotificationType = 'group_invite';

export interface NotificationDoc {
  id: string;
  type: NotificationType;
  groupId: string;
  groupName: string;
  fromUserId: string;
  fromDisplayName?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}

export interface PeerComparisonResult {
  userStrengths: string[];
  userGaps: string[];
  groupAverageSkills: string[];
  recommendation: string;
}

export interface BulkPatchPreview {
  userId: string;
  displayLabel: string;
  section: string;
  patch: unknown;
  currentSection: unknown;
  summary: string;
}
