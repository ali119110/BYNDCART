/**
 * Validates that a value is a string and conforms to optional rules.
 */
export const string = (rules) => {
  return (value, path) => {
    if (typeof value !== "string") {
      return {
        success: false,
        errors: [{ path, message: `Expected string, got ${typeof value}` }],
      };
    }

    if (rules?.min !== undefined && value.length < rules.min) {
      return {
        success: false,
        errors: [
          {
            path,
            message: `String must be at least ${rules.min} characters long`,
          },
        ],
      };
    }

    if (rules?.email && !value.includes("@")) {
      return {
        success: false,
        errors: [{ path, message: "Invalid email format" }],
      };
    }

    return { success: true, data: value };
  };
};

/**
 * Validates that a value is a number and conforms to optional bounds.
 */
export const number = (rules) => {
  return (value, path) => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return {
        success: false,
        errors: [{ path, message: `Expected number, got ${typeof value}` }],
      };
    }

    if (rules?.min !== undefined && value < rules.min) {
      return {
        success: false,
        errors: [{ path, message: `Number must be at least ${rules.min}` }],
      };
    }

    if (rules?.max !== undefined && value > rules.max) {
      return {
        success: false,
        errors: [{ path, message: `Number must be at most ${rules.max}` }],
      };
    }

    return { success: true, data: value };
  };
};

/**
 * Validates that a value is a boolean.
 */
export const boolean = () => {
  return (value, path) => {
    if (typeof value !== "boolean") {
      return {
        success: false,
        errors: [{ path, message: `Expected boolean, got ${typeof value}` }],
      };
    }

    return { success: true, data: value };
  };
};

/**
 * Validates that a value is an array of items matching the item validator.
 */
export const array = (itemValidator) => {
  return (value, path) => {
    if (!Array.isArray(value)) {
      return {
        success: false,
        errors: [{ path, message: `Expected array, got ${typeof value}` }],
      };
    }

    const errors = [];
    const validatedData = [];

    for (let i = 0; i < value.length; i++) {
      const res = itemValidator(value[i], `${path}[${i}]`);

      if (res.success) {
        validatedData.push(res.data);
      } else {
        errors.push(...res.errors);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: validatedData };
  };
};

/**
 * Validates that a value is an object conforming to a structured shape.
 */
export const object = (shape) => {
  return (value, path = "") => {
    if (typeof value !== "object" || value === null) {
      return {
        success: false,
        errors: [
          {
            path: path || "root",
            message: `Expected object, got ${value === null ? "null" : typeof value}`,
          },
        ],
      };
    }

    const errors = [];
    const validatedData = {};

    for (const key in shape) {
      const fieldPath = path ? `${path}.${key}` : key;
      const res = shape[key](value[key], fieldPath);

      if (res.success) {
        validatedData[key] = res.data;
      } else {
        errors.push(...res.errors);
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    return { success: true, data: validatedData };
  };
};
