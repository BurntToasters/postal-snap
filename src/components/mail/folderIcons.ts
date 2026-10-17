import {
  Archive,
  FileText,
  Folder,
  Inbox,
  Send,
  ShieldAlert,
  Trash,
} from "lucide-react";
import type { MailboxRole } from "../../types";

export const folderIcons: Record<MailboxRole, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  archive: Archive,
  trash: Trash,
  junk: ShieldAlert,
  other: Folder,
};
