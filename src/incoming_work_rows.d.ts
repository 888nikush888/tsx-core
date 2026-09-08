/** Durable ingress tables; source payload and selected configuration stay serialized until classification. */
export interface IncomingWorkRow {
  id: string; chat_id: string; message_id: number; message_json: string; config_json: string;
  workflow_revision_id: string | null; status: string; reason: string | null; created_at: number; updated_at: number;
}
export interface IncomingAlbumRow {
  id: string; chat_id: string; media_group_id: string; work_ids_json: string;
  config_json: string; ready_at: number; status: string;
}
