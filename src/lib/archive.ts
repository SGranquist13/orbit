import { confirmAction } from "./confirm";
import { api } from "./ipc";

/** Archives a workspace and removes its worktree. A worktree with unsaved work is refused by the
 *  backend ("Uncommitted changes: …"); the user is asked once before it is discarded with `force`. */
export async function archiveWithWorktree(id: string, name: string): Promise<void> {
  try {
    await api.archiveWorkspace(id, true);
  } catch (e) {
    const msg = String(e);
    const at = msg.indexOf("Uncommitted changes:");
    if (at < 0) throw e;
    const ok = await confirmAction(`Discard uncommitted changes in ${name}?\n\n${msg.slice(at)}`, "Discard");
    if (!ok) throw new Error("Archive cancelled: the worktree has uncommitted changes");
    await api.archiveWorkspace(id, true, true);
  }
}
