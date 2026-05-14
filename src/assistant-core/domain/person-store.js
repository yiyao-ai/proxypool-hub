import { createPerson, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class PersonStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'persons.json',
      rootKey: 'persons'
    });
  }

  findByExternalIdentity({ channel = '', externalUserId = '' } = {}) {
    const normalizedChannel = toText(channel).toLowerCase();
    const normalizedUserId = toText(externalUserId);
    if (!normalizedChannel || !normalizedUserId) return null;
    return this.records.find((entry) => (
      Array.isArray(entry?.externalIdentities)
      && entry.externalIdentities.some((identity) => (
        toText(identity?.channel).toLowerCase() === normalizedChannel
        && toText(identity?.externalUserId) === normalizedUserId
      ))
    )) || null;
  }

  create(payload = {}) {
    return this.save(createPerson(payload));
  }

  save(person = {}) {
    const normalized = createPerson({
      ...person,
      id: person.id,
      createdAt: person.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }
}

export const personStore = new PersonStore();

export default personStore;
