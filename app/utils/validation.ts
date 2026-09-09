export interface ValidationErrorDetail {
  path: string;
  message: string;
}

export type ValidatorResult<T> =
  | { success: true; data: T }
  | { success: false; errors: ValidationErrorDetail[] };

export type Validator<T> = (value: any, path: string) => ValidatorResult<T>;

/**
 * Validates that a value is a string and conforms to optional rules.
 */
export const string = (rules?: { min?: number; email?: boolean }) => {
  return (value: any, path: string): ValidatorResult<string> => {
    if (typeof value !== "string") {
      return { success: false, errors: [{ path, message: `Expected string, got ${typeof value}` }] };
    }
    if (rules?.min !== undefined && value.length < rules.min) {
      return { success: false, errors: [{ path, message: `String must be at least ${rules.min} characters long` }] };
    }
    if (rules?.email && !value.includes("@")) {
      return { success: false, errors: [{ path, message: "Invalid email format" }] };
    }
    return { success: true, data: value };
  };
};

/**
 * Validates that a value is a number and conforms to optional bounds.
 */
export const number = (rules?: { min?: number; max?: number }) => {
  return (value: any, path: string): ValidatorResult<number> => {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return { success: false, errors: [{ path, message: `Expected number, got ${typeof value}` }] };
    }
    if (rules?.min !== undefined && value < rules.min) {
      return { success: false, errors: [{ path, message: `Number must be at least ${rules.min}` }] };
    }
    if (rules?.max !== undefined && value > rules.max) {
      return { success: false, errors: [{ path, message: `Number must be at most ${rules.max}` }] };
    }
    return { success: true, data: value };
  };
};

/**
 * Validates that a value is a boolean.
 */
export const boolean = () => {
  return (value: any, path: string): ValidatorResult<boolean> => {
    if (typeof value !== "boolean") {
      return { success: false, errors: [{ path, message: `Expected boolean, got ${typeof value}` }] };
    }
    return { success: true, data: value };
  };
};

/**
 * Validates that a value is an array of items matching the item validator.
 */
export const array = <T>(itemValidator: Validator<T>) => {
  return (value: any, path: string): ValidatorResult<T[]> => {
    if (!Array.isArray(value)) {
      return { success: false, errors: [{ path, message: `Expected array, got ${typeof value}` }] };
    }
    const errors: ValidationErrorDetail[] = [];
    const validatedData: T[] = [];
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
export const object = <T extends Record<string, any>>(shape: { [K in keyof T]: Validator<T[K]> }) => {
  return (value: any, path = ""): ValidatorResult<T> => {
    if (typeof value !== "object" || value === null) {
      return { success: false, errors: [{ path: path || "root", message: `Expected object, got ${value === null ? "null" : typeof value}` }] };
    }
    const errors: ValidationErrorDetail[] = [];
    const validatedData = {} as T;
    
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
