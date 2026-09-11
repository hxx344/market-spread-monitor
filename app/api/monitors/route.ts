import { monitors } from "../../../lib/monitors";
export function GET() {
  return Response.json({ schemaVersion: 1, monitors }, { headers: { "Cache-Control": "no-store" } });
}
