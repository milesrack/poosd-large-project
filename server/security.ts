import helmet from "helmet";

export function securityHeaders(publicDeployment: boolean) {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: publicDeployment ? [] : null,
      },
    },
    strictTransportSecurity: publicDeployment,
  });
}
