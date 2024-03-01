import { Context } from 'aws-lambda';
import { v1 as uuid } from 'uuid';

export function buildContext(): Context {
	return {
		callbackWaitsForEmptyEventLoop: true,
		functionName: '',
		functionVersion: '',
		invokedFunctionArn: '',
		memoryLimitInMB: '128',
		awsRequestId: uuid(),
		logGroupName: '',
		logStreamName: '',

		getRemainingTimeInMillis() {
			return Infinity;
		},

		done() {},
		fail() {},
		succeed(messageOrObject: any) {},
	};
}
