import bodyParser from 'body-parser';
import { NextFunction } from 'express';


export function cloudfrontPost() {
	return (req: any, res: any, next: NextFunction) => {
		if (req.method === 'POST' || req.method === 'PUT') {
			bodyParser.raw({type: '*/*', inflate: false, limit: '1mb'})(req, res, (err) => {
				if (err) {
					next(err);
				}

				req.body = {
					data: req.body.subarray(0, 1000000).toString('base64'),
					encoding: 'base64',
					inputTruncated: req.body.length > 1000000
				};

				next();
			});
		} else {
			next();
		}
	};
}
