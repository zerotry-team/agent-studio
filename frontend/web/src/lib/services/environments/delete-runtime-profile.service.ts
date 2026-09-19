import "server-only";
import { RuntimeProfileRepository } from "@/lib/repositories";

export class DeleteRuntimeProfileService {
  constructor(private readonly profiles = new RuntimeProfileRepository()) {}

  invoke(id: string): Promise<void> {
    return this.profiles.remove(id);
  }
}
