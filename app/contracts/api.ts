const email = { type: 'string', format: 'email', maxLength: 254 };
export const phone = { type: 'string', pattern: '^1[3-9][0-9]{9}$' };
export const oneIdentity = [{ required: ['email'] }, { required: ['phone'] }];
const password = { type: 'string', minLength: 12, maxLength: 128 };

export const credentials = {
  type: 'object',
  additionalProperties: false,
  required: ['password'],
  oneOf: oneIdentity,
  properties: { email, phone, password }
};

export const registration = {
  ...credentials,
  required: [...credentials.required, 'invite'],
  properties: { ...credentials.properties, invite: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } }
};

export const courseInput = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'term'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    teacher: { type: 'string', maxLength: 100 },
    term: { type: 'string', minLength: 1, maxLength: 80 }
  }
};

export const course = {
  type: 'object',
  required: ['id', 'name', 'teacher', 'term'],
  properties: { id: { type: 'string', format: 'uuid' }, ...courseInput.properties }
};

export const courseResult = {
  type: 'object',
  required: ['course', 'reused'],
  properties: { course, reused: { type: 'boolean' } }
};

export const courseProgress = {
  type: 'object',
  required: ['total', 'completed', 'incomplete', 'courses'],
  properties: {
    total: { type: 'integer' },
    completed: { type: 'integer' },
    incomplete: { type: 'integer' },
    courses: {
      type: 'array',
      items: {
        type: 'object',
        required: [...course.required, 'status', 'totalPapers', 'completedPapers', 'remainingPapers'],
        properties: {
          ...course.properties,
          draftPaperId: { type: ['string', 'null'] },
          examAt: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['awaiting_upload', 'awaiting_review', 'completed'] },
          totalPapers: { type: 'integer' },
          completedPapers: { type: 'integer' },
          remainingPapers: { type: 'integer' }
        }
      }
    }
  }
};

export const session = {
  type: 'object',
  required: ['csrfToken'],
  properties: { email, phone, csrfToken: { type: 'string' }, isAdmin: { type: 'boolean' } }
};
