import winston from "winston";
import ecsFormat from "@elastic/ecs-winston-format";

export const logger = winston.createLogger({
    level: 'info',
    format: ecsFormat({ convertReqRes: true }), // Converts HTTP request/response objects to ECS format
    transports: [
        new winston.transports.Console(),
    ],
});
