import { StatusCodes } from 'http-status-codes';
import { HttpError } from './http.error';

export class MethodNotAllowedError extends HttpError {
	constructor(message: string, lastError: Error|null = null) {
		super(message, StatusCodes.METHOD_NOT_ALLOWED, lastError);
	}
}
