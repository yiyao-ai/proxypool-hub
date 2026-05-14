import agentChannelConversationStore from '../../agent-channels/conversation-store.js';

import personStore, { PersonStore } from './person-store.js';
import projectStore, { ProjectStore } from './project-store.js';
import taskStore, { TaskStore } from './task-store.js';
import executionStore, { ExecutionStore } from './execution-store.js';
import scheduledTaskStore, { ScheduledTaskStore } from './scheduled-task-store.js';
import episodeLedger, { EpisodeLedger } from './episode-ledger.js';
import ConversationStateService from './conversation-state-service.js';
import {
  appendUniqueId,
  buildStructuredRationale,
  createProject,
  createTask,
  nowIso,
  toText
} from './models.js';
import { buildTaskActivitySnapshot } from './task-activity-snapshot.js';

function pickIdleArchiveDays(projectKind) {
  return projectKind === 'misc' ? 30 : 180;
}

function mapRuntimeStatusToExecutionStatus(status = '') {
  const normalized = toText(status).toLowerCase();
  if (normalized === 'starting') return 'spawning';
  if (normalized === 'running') return 'running';
  if (normalized === 'waiting_approval') return 'waiting_approval';
  if (normalized === 'waiting_user') return 'waiting_user';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled') return 'cancelled';
  if (normalized === 'ready') return 'ready';
  return 'spawning';
}

function createHandoffPacket({
  id = '',
  kind = 'progress',
  title = '',
  payload = null,
  fromExecutionId = '',
  createdAt = '',
  status = 'pending',
  consumedAt = '',
  metadata = {}
} = {}) {
  return {
    id: toText(id) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    kind: ['progress', 'review_request', 'deliverable_ready', 'retry_context'].includes(toText(kind))
      ? toText(kind)
      : 'progress',
    title: toText(title),
    payload: payload && typeof payload === 'object' ? payload : null,
    fromExecutionId: toText(fromExecutionId),
    status: ['pending', 'consumed'].includes(toText(status)) ? toText(status) : 'pending',
    createdAt: toText(createdAt) || nowIso(),
    consumedAt: toText(consumedAt),
    metadata: metadata && typeof metadata === 'object' ? metadata : {}
  };
}

function mapScheduledTaskEpisodeKind(currentState = '', nextState = '') {
  const current = toText(currentState);
  const next = toText(nextState);
  if (next === 'running') return 'scheduled_task.triggered';
  if (next === 'paused') return 'scheduled_task.paused';
  if (next === 'failed') return 'scheduled_task.failed';
  if (next === 'completed') return 'scheduled_task.completed';
  if (next === 'cancelled') return 'scheduled_task.cancelled';
  if (next === 'scheduled' && current === 'paused') return 'scheduled_task.resumed';
  if (next === 'scheduled' && current === 'running') return 'scheduled_task.rescheduled';
  if (next === 'scheduled') return 'scheduled_task.scheduled';
  return 'scheduled_task.updated';
}

export class StateCoordinator {
  constructor({
    personStore: personStoreArg = personStore,
    projectStore: projectStoreArg = projectStore,
    taskStore: taskStoreArg = taskStore,
    executionStore: executionStoreArg = executionStore,
    scheduledTaskStore: scheduledTaskStoreArg = scheduledTaskStore,
    episodeLedger: episodeLedgerArg = episodeLedger,
    conversationStore = agentChannelConversationStore,
    conversationStateService = null
  } = {}) {
    this.personStore = personStoreArg instanceof PersonStore ? personStoreArg : personStoreArg;
    this.projectStore = projectStoreArg instanceof ProjectStore ? projectStoreArg : projectStoreArg;
    this.taskStore = taskStoreArg instanceof TaskStore ? taskStoreArg : taskStoreArg;
    this.executionStore = executionStoreArg instanceof ExecutionStore ? executionStoreArg : executionStoreArg;
    this.scheduledTaskStore = scheduledTaskStoreArg instanceof ScheduledTaskStore ? scheduledTaskStoreArg : scheduledTaskStoreArg;
    this.episodeLedger = episodeLedgerArg instanceof EpisodeLedger ? episodeLedgerArg : episodeLedgerArg;
    this.conversationStore = conversationStore;
    this.conversationStateService = conversationStateService || new ConversationStateService({
      conversationStore: this.conversationStore
    });
  }

  // StateCoordinator is the intended write boundary for durable assistant-domain facts.
  // Conversation aggregate compatibility patches may still exist temporarily outside this class during migration.

  findOrCreatePersonByConversation(conversation = null) {
    if (!conversation?.id) {
      throw new Error('conversation is required');
    }
    const channel = toText(conversation.channel).toLowerCase();
    const externalUserId = toText(conversation.externalUserId) || 'anonymous-user';
    let person = this.personStore.findByExternalIdentity({ channel, externalUserId });
    if (!person) {
      person = this.personStore.create({
        externalIdentities: [{ channel, externalUserId }]
      });
      const miscProject = this.projectStore.create(createProject({
        ownerPersonId: person.id,
        name: 'misc',
        aliases: ['misc'],
        kind: 'misc',
        summary: 'Default catch-all project for ad hoc tasks.'
      }));
      person = this.personStore.save({
        ...person,
        miscProjectId: miscProject.id,
        knownProjectIds: appendUniqueId(person.knownProjectIds, miscProject.id)
      });
      this.recordEpisode({
        kind: 'person.created',
        personId: person.id,
        conversationId: conversation.id,
        payload: {
          channel,
          externalUserId,
          miscProjectId: miscProject.id
        }
      });
    }
    this.conversationStateService.bindPerson(conversation.id, person.id);
    return person;
  }

  ingestConversationTurn({
    conversation = null,
    role = '',
    text = '',
    createdAt = ''
  } = {}) {
    if (!conversation?.id) {
      throw new Error('conversation is required');
    }

    const person = this.findOrCreatePersonByConversation(conversation);
    const normalizedText = toText(text);
    if (normalizedText) {
      this.appendConversationMessage({
        conversationId: conversation.id,
        role: toText(role) || 'user',
        text: normalizedText,
        createdAt
      });
    }
    return person;
  }

  resolveProject({
    personId = '',
    conversationId = '',
    projectId = '',
    cwd = '',
    explicitName = '',
    metadata = {}
  } = {}) {
    const normalizedProjectId = toText(projectId);
    if (normalizedProjectId) {
      return this.projectStore.get(normalizedProjectId);
    }
    const normalizedCwd = toText(cwd);
    if (normalizedCwd) {
      const matchedByCwd = this.projectStore.findByCwd(normalizedCwd);
      if (matchedByCwd) return matchedByCwd;
    }
    const normalizedExplicitName = toText(explicitName).toLowerCase();
    if (normalizedExplicitName) {
      const matchedByAlias = this.projectStore.listByOwner(personId, { limit: 200 })
        .find((entry) => (
          entry.name.toLowerCase() === normalizedExplicitName
          || (Array.isArray(entry.aliases) && entry.aliases.includes(normalizedExplicitName))
        ));
      if (matchedByAlias) return matchedByAlias;
    }
    const owner = this.personStore.get(personId);
    if (!owner) {
      throw new Error('person not found for resolveProject');
    }
    return this.projectStore.get(owner.miscProjectId);
  }

  createTask({
    personId = '',
    projectId = '',
    title = '',
    goal = '',
    conversationId = '',
    completionCriteria = 'explicit_user_close',
    assistantRationale = null,
    metadata = {}
  } = {}) {
    const project = this.projectStore.get(projectId);
    if (!project?.id) {
      throw new Error('project not found');
    }
    const task = this.taskStore.create(createTask({
      ownerPersonId: personId,
      projectId: project.id,
      title,
      goal,
      completionCriteria,
      idleAutoArchiveDays: pickIdleArchiveDays(project.kind),
      lastConversationId: conversationId,
      assistantRationale: buildStructuredRationale(assistantRationale),
      metadata
    }));
    this.projectStore.save({
      ...project,
      activeTaskIds: appendUniqueId(project.activeTaskIds, task.id),
      archivedTaskIds: (project.archivedTaskIds || []).filter((entry) => entry !== task.id),
      lastConversationId: toText(conversationId) || project.lastConversationId,
      lastActiveAt: nowIso()
    });
    this.recordEpisode({
      kind: 'task.created',
      personId,
      projectId: project.id,
      taskId: task.id,
      conversationId,
      payload: {
        title: task.title,
        completionCriteria: task.completionCriteria
      }
    });
    return task;
  }

  createProject({
    ownerPersonId = '',
    name = '',
    aliases = [],
    kind = 'misc',
    cwd = '',
    summary = '',
    lastConversationId = '',
    metadata = {}
  } = {}) {
    const owner = this.personStore.get(ownerPersonId);
    if (!owner?.id) {
      throw new Error('person not found');
    }
    const project = this.projectStore.create(createProject({
      ownerPersonId: owner.id,
      name,
      aliases,
      kind,
      cwd,
      summary,
      lastConversationId,
      metadata
    }));
    this.personStore.save({
      ...owner,
      knownProjectIds: appendUniqueId(owner.knownProjectIds, project.id)
    });
    this.recordEpisode({
      kind: 'project.created',
      personId: owner.id,
      projectId: project.id,
      conversationId: toText(lastConversationId),
      payload: {
        name: project.name,
        kind: project.kind,
        cwd: project.cwd
      }
    });
    return project;
  }

  updateTask({ id = '', patch = {}, reason = '' } = {}) {
    const current = this.taskStore.get(id);
    if (!current?.id) {
      throw new Error('task not found');
    }
    const next = this.taskStore.save({
      ...current,
      ...patch,
      assistantRationale: patch.assistantRationale === undefined
        ? current.assistantRationale
        : buildStructuredRationale(patch.assistantRationale)
    });
    this.recordEpisode({
      kind: 'task.updated',
      personId: next.ownerPersonId,
      projectId: next.projectId,
      taskId: next.id,
      conversationId: next.lastConversationId,
      payload: {
        reason: toText(reason),
        patchKeys: Object.keys(patch || {})
      }
    });
    return next;
  }

  moveTaskToProject({
    taskId = '',
    targetProjectId = '',
    reason = '',
    conversationId = ''
  } = {}) {
    const task = this.taskStore.get(toText(taskId));
    if (!task?.id) {
      throw new Error('task not found');
    }
    const targetProject = this.projectStore.get(toText(targetProjectId));
    if (!targetProject?.id) {
      throw new Error('target project not found');
    }
    const sourceProject = this.projectStore.get(task.projectId);
    if (sourceProject?.id && sourceProject.id !== targetProject.id) {
      this.projectStore.save({
        ...sourceProject,
        activeTaskIds: (sourceProject.activeTaskIds || []).filter((entry) => entry !== task.id),
        archivedTaskIds: (sourceProject.archivedTaskIds || []).filter((entry) => entry !== task.id),
        lastActiveAt: nowIso()
      });
    }
    this.projectStore.save({
      ...targetProject,
      activeTaskIds: appendUniqueId(targetProject.activeTaskIds, task.id),
      archivedTaskIds: (targetProject.archivedTaskIds || []).filter((entry) => entry !== task.id),
      lastConversationId: toText(conversationId) || task.lastConversationId || targetProject.lastConversationId,
      lastActiveAt: nowIso()
    });
    const nextTask = this.taskStore.save({
      ...task,
      projectId: targetProject.id,
      lastConversationId: toText(conversationId) || task.lastConversationId
    });
    this.recordEpisode({
      kind: 'task.moved',
      personId: nextTask.ownerPersonId,
      projectId: targetProject.id,
      taskId: nextTask.id,
      conversationId: toText(conversationId) || nextTask.lastConversationId,
      payload: {
        fromProjectId: sourceProject?.id || '',
        toProjectId: targetProject.id,
        reason: toText(reason)
      }
    });
    return {
      task: nextTask,
      sourceProject,
      targetProject: this.projectStore.get(targetProject.id)
    };
  }

  promoteTaskToProject({
    taskId = '',
    name = '',
    cwd = '',
    kind = '',
    reason = '',
    conversationId = ''
  } = {}) {
    const task = this.taskStore.get(toText(taskId));
    if (!task?.id) {
      throw new Error('task not found');
    }
    const project = this.createProject({
      ownerPersonId: task.ownerPersonId,
      name: toText(name) || task.title || 'Promoted Project',
      aliases: [task.title],
      kind: toText(kind) || (toText(cwd) ? 'code_project' : 'misc'),
      cwd,
      summary: task.summary,
      lastConversationId: toText(conversationId) || task.lastConversationId,
      metadata: {
        sourceTaskId: task.id,
        promotedFromProjectId: task.projectId
      }
    });
    const moved = this.moveTaskToProject({
      taskId: task.id,
      targetProjectId: project.id,
      reason: toText(reason) || 'promote_task_to_project',
      conversationId: toText(conversationId) || task.lastConversationId
    });
    return {
      project,
      task: moved.task
    };
  }

  createExecution({
    taskId = '',
    ownerPersonId = '',
    provider = 'codex',
    role = 'free',
    objective = '',
    conversationId = '',
    assistantRationale = null,
    metadata = {}
  } = {}) {
    const task = this.taskStore.get(taskId);
    if (!task?.id) {
      throw new Error('task not found');
    }
    const execution = this.executionStore.create({
      taskId: task.id,
      ownerPersonId: ownerPersonId || task.ownerPersonId,
      provider,
      role,
      objective,
      status: 'spawning',
      assistantRationale: buildStructuredRationale(assistantRationale),
      metadata
    });
    this.taskStore.attachExecution(task.id, execution.id, { active: true });
    this.updateTask({
      id: task.id,
      patch: {
        lastConversationId: toText(conversationId) || task.lastConversationId,
        lastActiveAt: nowIso()
      },
      reason: 'execution_created'
    });
    this.recordEpisode({
      kind: 'execution.created',
      personId: execution.ownerPersonId,
      projectId: task.projectId,
      taskId: task.id,
      executionId: execution.id,
      conversationId,
      payload: {
        provider,
        role,
        objective
      }
    });
    return execution;
  }

  bindExecutionRuntime({
    executionId = '',
    runtimeSessionId = '',
    providerSessionId = '',
    status = '',
    conversationId = '',
    metadata = {},
    patch = {}
  } = {}) {
    const execution = this.executionStore.get(executionId);
    if (!execution?.id) {
      throw new Error('execution not found');
    }
    const next = this.executionStore.bindRuntimeSession(execution.id, runtimeSessionId, {
      ...((patch && typeof patch === 'object') ? patch : {}),
      providerSessionId: toText(providerSessionId) || execution.providerSessionId,
      status: toText(status) || execution.status,
      metadata: {
        ...(execution.metadata || {}),
        ...(metadata && typeof metadata === 'object' ? metadata : {})
      }
    });
    const task = this.taskStore.get(execution.taskId);
    this.recordEpisode({
      kind: 'execution.runtime_bound',
      personId: next.ownerPersonId,
      projectId: task?.projectId || '',
      taskId: next.taskId,
      executionId: next.id,
      runtimeSessionId,
      conversationId: toText(conversationId) || task?.lastConversationId || '',
      payload: {
        providerSessionId: next.providerSessionId,
        status: next.status
      }
    });
    return next;
  }

  syncTaskExecutionBridge({
    supervisorTask = null,
    session = null,
    input = '',
    cwd = '',
    conversationId = '',
    provider = '',
    role = 'primary',
    reuseExecutionId = '',
    assistantRationale = null
  } = {}) {
    if (!supervisorTask?.id || !session?.id) {
      return null;
    }

    const resolvedConversationId = toText(
      conversationId
      || supervisorTask.lastConversationId
      || supervisorTask.conversationId
    );
    const conversation = resolvedConversationId
      ? this.conversationStore?.get?.(resolvedConversationId) || null
      : null;
    if (!conversation?.id) {
      return null;
    }

    const person = this.findOrCreatePersonByConversation(conversation);
    const project = this.resolveProject({
      personId: person.id,
      conversationId: conversation.id,
      cwd: session.cwd || cwd || supervisorTask.cwd || '',
      projectId: supervisorTask?.metadata?.assistantProjectId || ''
    });

    let assistantTask = supervisorTask?.metadata?.assistantTaskId
      ? this.taskStore.get(supervisorTask.metadata.assistantTaskId)
      : null;
    if (!assistantTask) {
      assistantTask = this.createTask({
        personId: person.id,
        projectId: project.id,
        title: supervisorTask.title || session.title || input,
        goal: supervisorTask.goal || input,
        conversationId: conversation.id,
        assistantRationale: assistantRationale || {
          routeReason: 'dual-write from supervisor task',
          candidateEvidence: [`supervisorTaskId:${supervisorTask.id}`]
        },
        metadata: {
          supervisorTaskId: supervisorTask.id,
          originKind: toText(supervisorTask?.metadata?.originKind),
          cwd: session.cwd || cwd || supervisorTask.cwd || '',
          provider: session.provider || provider
        }
      });
    }

    let assistantExecution = reuseExecutionId
      ? this.executionStore.get(reuseExecutionId)
      : null;
    if (!assistantExecution && session.id) {
      assistantExecution = this.executionStore.findByRuntimeSessionId(session.id);
    }
    if (!assistantExecution) {
      assistantExecution = this.createExecution({
        taskId: assistantTask.id,
        ownerPersonId: person.id,
        provider: session.provider || provider,
        role: toText(role) || 'primary',
        objective: input || supervisorTask.goal || supervisorTask.intent || supervisorTask.title || '',
        conversationId: conversation.id,
        assistantRationale: assistantRationale || {
          routeReason: 'dual-write execution create',
          candidateEvidence: [`supervisorTaskId:${supervisorTask.id}`, `runtimeSessionId:${session.id}`]
        },
        metadata: {
          supervisorTaskId: supervisorTask.id
        }
      });
    }

    const execution = this.bindExecutionRuntime({
      executionId: assistantExecution.id,
      runtimeSessionId: session.id,
      providerSessionId: session.providerSessionId || '',
      status: mapRuntimeStatusToExecutionStatus(session.status),
      conversationId: conversation.id,
      metadata: {
        supervisorTaskId: supervisorTask.id
      },
      patch: {
        objective: input || assistantExecution.objective || supervisorTask.goal || '',
        lastInputPreview: input || assistantExecution.lastInputPreview || '',
        lastTurnAt: toText(session.updatedAt || assistantExecution.lastTurnAt),
        lastTurnSummary: toText(session.summary || assistantExecution.lastTurnSummary),
        lastMeaningfulProgressAt: toText(session.updatedAt || assistantExecution.lastMeaningfulProgressAt)
      }
    });

    this.updateConversationWorkingSet({
      conversationId: conversation.id,
      patch: {
        primaryProjectId: project.id,
        primaryTaskId: assistantTask.id,
        recentTaskIds: [assistantTask.id],
        mentionedProjectIds: [project.id]
      }
    });

    return {
      person,
      project,
      task: assistantTask,
      execution
    };
  }

  recordEpisode(payload = {}) {
    return this.episodeLedger.append(payload);
  }

  recordRuntimeEpisode({
    kind = '',
    conversationId = '',
    runtimeSessionId = '',
    personId = '',
    projectId = '',
    taskId = '',
    executionId = '',
    payload = {},
    metadata = {}
  } = {}) {
    const normalizedRuntimeSessionId = toText(runtimeSessionId);
    const execution = toText(executionId)
      ? this.executionStore.get(toText(executionId))
      : (normalizedRuntimeSessionId
          ? this.executionStore.findByRuntimeSessionId(normalizedRuntimeSessionId)
          : null);
    const task = toText(taskId)
      ? this.taskStore.get(toText(taskId))
      : (execution?.taskId ? this.taskStore.get(execution.taskId) : null);
    const project = toText(projectId)
      ? this.projectStore.get(toText(projectId))
      : (task?.projectId ? this.projectStore.get(task.projectId) : null);

    return this.recordEpisode({
      kind,
      personId: toText(personId) || task?.ownerPersonId || execution?.ownerPersonId || '',
      projectId: toText(projectId) || project?.id || '',
      taskId: toText(taskId) || task?.id || '',
      executionId: toText(executionId) || execution?.id || '',
      runtimeSessionId: normalizedRuntimeSessionId,
      conversationId: toText(conversationId),
      payload,
      metadata
    });
  }

  recordDeliveryEpisode({
    delivery = null,
    conversationId = '',
    runtimeSessionId = '',
    payload = {},
    metadata = {}
  } = {}) {
    const normalizedStatus = toText(delivery?.status);
    if (!normalizedStatus) {
      return null;
    }
    const kind = normalizedStatus === 'suppressed'
      ? 'delivery.suppressed'
      : (normalizedStatus === 'sent' ? 'delivery.sent' : `delivery.${normalizedStatus}`);
    return this.recordRuntimeEpisode({
      kind,
      conversationId: toText(conversationId) || toText(delivery?.conversationId),
      runtimeSessionId: toText(runtimeSessionId) || toText(delivery?.sessionId),
      payload: {
        deliveryId: toText(delivery?.id),
        channel: toText(delivery?.channel),
        status: normalizedStatus,
        direction: toText(delivery?.direction),
        eventSeq: Number.isFinite(Number(delivery?.eventSeq)) ? Number(delivery.eventSeq) : null,
        externalMessageId: toText(delivery?.externalMessageId),
        sourceType: toText(delivery?.payload?.sourceType),
        eventType: toText(delivery?.payload?.eventType),
        suppressionReason: toText(delivery?.payload?.suppressionReason),
        text: toText(delivery?.payload?.text || delivery?.payload?.fullText),
        ...((payload && typeof payload === 'object') ? payload : {})
      },
      metadata: {
        source: 'state_coordinator_delivery_record',
        ...((metadata && typeof metadata === 'object') ? metadata : {})
      }
    });
  }

  addExecutionHandoff({
    targetExecutionId = '',
    fromExecutionId = '',
    kind = 'progress',
    title = '',
    payload = null,
    conversationId = '',
    metadata = {}
  } = {}) {
    const target = this.executionStore.get(toText(targetExecutionId));
    if (!target?.id) {
      throw new Error('target execution not found');
    }
    const packet = createHandoffPacket({
      kind,
      title,
      payload,
      fromExecutionId,
      metadata
    });
    const next = this.executionStore.save({
      ...target,
      handoffInbox: [...(Array.isArray(target.handoffInbox) ? target.handoffInbox : []), packet]
    });
    this.recordEpisode({
      kind: 'execution_handoff_prepared',
      personId: next.ownerPersonId,
      taskId: next.taskId,
      executionId: next.id,
      conversationId: toText(conversationId),
      payload: {
        handoffId: packet.id,
        handoffKind: packet.kind,
        title: packet.title,
        fromExecutionId: packet.fromExecutionId
      },
      metadata: {
        source: 'state_coordinator_handoff'
      }
    });
    return {
      execution: next,
      handoff: packet
    };
  }

  consumeExecutionHandoff({
    executionId = '',
    handoffId = '',
    conversationId = ''
  } = {}) {
    const execution = this.executionStore.get(toText(executionId));
    if (!execution?.id) {
      throw new Error('execution not found');
    }
    const inbox = Array.isArray(execution.handoffInbox) ? execution.handoffInbox : [];
    const index = inbox.findIndex((entry) => toText(entry?.id) === toText(handoffId));
    if (index < 0) {
      throw new Error('handoff not found');
    }
    const packet = createHandoffPacket({
      ...inbox[index],
      status: 'consumed',
      consumedAt: nowIso()
    });
    const nextInbox = [...inbox];
    nextInbox[index] = packet;
    const next = this.executionStore.save({
      ...execution,
      handoffInbox: nextInbox
    });
    this.recordEpisode({
      kind: 'execution_handoff_consumed',
      personId: next.ownerPersonId,
      taskId: next.taskId,
      executionId: next.id,
      conversationId: toText(conversationId),
      payload: {
        handoffId: packet.id,
        handoffKind: packet.kind,
        title: packet.title,
        fromExecutionId: packet.fromExecutionId
      },
      metadata: {
        source: 'state_coordinator_handoff'
      }
    });
    return {
      execution: next,
      handoff: packet
    };
  }

  createScheduledTask({
    personId = '',
    projectId = '',
    taskId = '',
    executionId = '',
    kind = 'check_in',
    title = '',
    schedule = {},
    payload = null,
    source = 'system',
    metadata = {}
  } = {}) {
    const scheduledTask = this.scheduledTaskStore.create({
      personId,
      projectId,
      taskId,
      executionId,
      kind,
      title,
      schedule,
      payload,
      source,
      metadata
    });
    this.recordEpisode({
      kind: 'scheduled_task.created',
      personId: scheduledTask.personId,
      projectId: scheduledTask.projectId,
      taskId: scheduledTask.taskId,
      executionId: scheduledTask.executionId,
      payload: {
        scheduledTaskId: scheduledTask.id,
        taskKind: scheduledTask.kind,
        title: scheduledTask.title,
        triggerAt: scheduledTask.schedule?.triggerAt || '',
        scheduleType: scheduledTask.schedule?.type || ''
      },
      metadata: {
        source: 'state_coordinator_scheduled_task'
      }
    });
    return scheduledTask;
  }

  updateScheduledTaskState({
    id = '',
    state = '',
    patch = {},
    reason = ''
  } = {}) {
    const current = this.scheduledTaskStore.get(toText(id));
    if (!current?.id) {
      throw new Error('scheduled task not found');
    }
    const next = this.scheduledTaskStore.save({
      ...current,
      ...patch,
      state: toText(state) || current.state
    });
    this.recordEpisode({
      kind: mapScheduledTaskEpisodeKind(current.state, next.state),
      personId: next.personId,
      projectId: next.projectId,
      taskId: next.taskId,
      executionId: next.executionId,
      payload: {
        scheduledTaskId: next.id,
        previousState: current.state,
        state: next.state,
        reason: toText(reason),
        nextRunAt: toText(next.nextRunAt),
        lastRunAt: toText(next.lastRunAt),
        lastResultPreview: toText(next.lastResultPreview),
        lastError: toText(next.lastError)
      },
      metadata: {
        source: 'state_coordinator_scheduled_task'
      }
    });
    return next;
  }

  recordApprovalPolicy(payload = {}) {
    return this.recordEpisode({
      kind: 'policy.recorded',
      ...payload
    });
  }

  updateConversationWorkingSet(input = {}) {
    const conversationId = toText(input.conversationId);
    if (!conversationId) {
      throw new Error('conversationId is required');
    }
    return this.conversationStateService.updateWorkingSet(conversationId, input.patch || {});
  }

  appendConversationMessage(input = {}) {
    const conversationId = toText(input.conversationId);
    if (!conversationId) {
      throw new Error('conversationId is required');
    }
    return this.conversationStateService.appendRecentMessage(conversationId, {
      role: input.role,
      text: input.text,
      createdAt: input.createdAt
    });
  }

  updateAutonomy({ scope = 'task', scopeRef = '', patch = {} } = {}) {
    const normalizedScope = toText(scope);
    const normalizedScopeRef = toText(scopeRef);
    if (!normalizedScopeRef) {
      throw new Error('scopeRef is required');
    }
    if (normalizedScope === 'person') {
      const current = this.personStore.get(normalizedScopeRef);
      if (!current?.id) throw new Error('person not found');
      return this.personStore.save({
        ...current,
        profile: {
          ...(current.profile || {}),
          autonomy: {
            ...(current.profile?.autonomy || {}),
            ...(patch || {})
          }
        }
      });
    }
    if (normalizedScope === 'project') {
      const current = this.projectStore.get(normalizedScopeRef);
      if (!current?.id) throw new Error('project not found');
      return this.projectStore.save({
        ...current,
        autonomy: {
          ...(current.autonomy || {}),
          ...(patch || {})
        }
      });
    }
    if (normalizedScope === 'task') {
      const current = this.taskStore.get(normalizedScopeRef);
      if (!current?.id) throw new Error('task not found');
      return this.taskStore.save({
        ...current,
        autonomy: {
          ...(current.autonomy || {}),
          ...(patch || {})
        }
      });
    }
    if (normalizedScope === 'execution') {
      const current = this.executionStore.get(normalizedScopeRef);
      if (!current?.id) throw new Error('execution not found');
      return this.executionStore.save({
        ...current,
        autonomy: {
          ...(current.autonomy || {}),
          ...(patch || {})
        }
      });
    }
    throw new Error(`unsupported autonomy scope: ${normalizedScope}`);
  }

  listProjects(filters = {}) {
    return this.projectStore.listByOwner(filters.personId, {
      limit: filters.limit || 100,
      state: filters.state || ''
    });
  }

  listTasks(filters = {}) {
    return this.taskStore.listByProject(filters.projectId, {
      limit: filters.limit || 100,
      lifecycleState: filters.lifecycleState || ''
    });
  }

  listExecutions(filters = {}) {
    return this.executionStore.listByTask(filters.taskId, {
      limit: filters.limit || 100,
      status: filters.status || ''
    });
  }

  getTaskDashboard(taskId) {
    const task = this.taskStore.get(taskId);
    if (!task?.id) return null;
    const project = this.projectStore.get(task.projectId);
    const executions = this.executionStore.listByTask(task.id, { limit: 200 });
    return {
      task,
      project,
      executions,
      activitySnapshot: buildTaskActivitySnapshot(executions)
    };
  }

  getPersonDashboard(personId) {
    const person = this.personStore.get(toText(personId));
    if (!person?.id) return null;
    const projects = this.projectStore.listByOwner(person.id, { limit: 500 });
    const projectIds = new Set(projects.map((entry) => entry.id));
    const tasks = this.taskStore.list({
      limit: 1000,
      predicate: (entry) => projectIds.has(entry.projectId)
    });
    const taskIds = new Set(tasks.map((entry) => entry.id));
    const executions = this.executionStore.list({
      limit: 1000,
      predicate: (entry) => taskIds.has(entry.taskId)
    });
    return {
      person,
      projects,
      tasks,
      executions,
      summary: {
        projectCount: projects.length,
        activeProjectCount: projects.filter((entry) => entry.state === 'active').length,
        taskCount: tasks.length,
        openTaskCount: tasks.filter((entry) => entry.lifecycleState === 'open').length,
        executionCount: executions.length,
        activeExecutionCount: executions.filter((entry) => ['spawning', 'ready', 'running', 'waiting_approval', 'waiting_user'].includes(entry.status)).length
      }
    };
  }
}

export const stateCoordinator = new StateCoordinator();

export default stateCoordinator;
