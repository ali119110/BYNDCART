
export interface ApiSuccessResponse<T> {
  success: true;
  message: string;
  data: T;
}

export interface ApiErrorPayload {
  message: string;
  code: string;
  details?: any;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorPayload;
}

/**
 * Standard utility to build a success JSON response.
 */
export function successResponse<T>(data: T, message = "Success", status = 200) {
  const payload: ApiSuccessResponse<T> = {
    success: true,
    message,
    data,
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Standard utility to build an error JSON response.
 */
export function errorResponse(message: string, code: string, status = 400, details?: any) {
  const payload: ApiErrorResponse = {
    success: false,
    error: {
      message,
      code,
      details,
    },
  };
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Convenience helper for validation failures.
 */
export function validationError(details: any, message = "Input validation failed") {
  return errorResponse(message, "VALIDATION_ERROR", 400, details);
}

/**
 * Convenience helper for unauthenticated requests.
 */
export function authError(message = "Session authentication context required") {
  return errorResponse(message, "UNAUTHENTICATED", 401);
}

/**
 * Convenience helper for unauthorized/forbidden actions.
 */
export function forbiddenError(message = "Unauthorized permission level") {
  return errorResponse(message, "FORBIDDEN", 403);
}

/**
 * Convenience helper for non-existent entities.
 */
export function notFoundError(message = "Resource not found") {
  return errorResponse(message, "NOT_FOUND", 404);
}

/**
 * Convenience helper for internal system faults.
 */
export function internalError(message = "Internal server error", details?: any) {
  return errorResponse(message, "INTERNAL_ERROR", 500, details);
}
