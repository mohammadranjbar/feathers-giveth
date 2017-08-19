import errors from 'feathers-errors';
import { pluck, checkContext, getByDot, setByDot } from 'feathers-hooks-common';

// A hook that sanitizes ethereum addresses

export const sanitizeAddress = (...fieldNames) => {
  return context => {
    checkContext(context, 'before', [ 'create', 'update', 'patch' ]);

    fieldNames.forEach(fieldName => {
      const value = getByDot(context.data, fieldName);
      if (value !== undefined) {
        setByDot(context.data, fieldName, _sanitizeAddress(value));
      }
    });

    return context;
  }
};

const _sanitizeAddress = addr => {
  return (addr.toLowerCase().startsWith('0x')) ? addr : `0x${addr}`;
};

export const validateAddress = (...fieldNames) => {
  return context => {
    checkContext(context, 'before', [ 'create', 'update', 'patch' ]);

    fieldNames.forEach(fieldName => {
      const value = getByDot(context.data, fieldName);
      if (value !== undefined && !/^(0x)?[0-9a-f]{40}$/i.test(value)) {
        throw new errors.BadRequest(
          `Invalid address provided for field "${fieldName}": "${value}".`,
        );
      }
    });

    console.log(context.data);

    return context;
  }
};