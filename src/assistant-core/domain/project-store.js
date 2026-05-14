import { createProject, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class ProjectStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'projects.json',
      rootKey: 'projects'
    });
  }

  listByOwner(ownerPersonId, { limit = 100, state = '' } = {}) {
    const normalizedOwnerPersonId = toText(ownerPersonId);
    const normalizedState = toText(state);
    return this.list({
      limit,
      predicate: (entry) => (
        (!normalizedOwnerPersonId || entry.ownerPersonId === normalizedOwnerPersonId)
        && (!normalizedState || entry.state === normalizedState)
      )
    });
  }

  getMiscProjectForPerson(ownerPersonId) {
    const normalizedOwnerPersonId = toText(ownerPersonId);
    if (!normalizedOwnerPersonId) return null;
    return this.records.find((entry) => entry.ownerPersonId === normalizedOwnerPersonId && entry.kind === 'misc') || null;
  }

  findByCwd(cwd = '') {
    const normalizedCwd = toText(cwd);
    if (!normalizedCwd) return null;
    return this.records.find((entry) => toText(entry?.cwd) === normalizedCwd) || null;
  }

  create(payload = {}) {
    return this.save(createProject(payload));
  }

  save(project = {}) {
    const normalized = createProject({
      ...project,
      id: project.id,
      createdAt: project.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }
}

export const projectStore = new ProjectStore();

export default projectStore;
