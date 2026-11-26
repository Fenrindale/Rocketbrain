# Reviewed Kubernetes operations

Connect the Kubernetes explorer to a reviewed kubeconfig context and select a namespace. The connection uses the selected context's embedded credentials and the cluster's existing permissions.

## Scale a Deployment

Choose **Scale Kubernetes Deployment** on a Deployment row. Enter the desired count and review the server dry-run before approving. Rocketbrain checks the Deployment identity, resource version and existing replica count again before sending the scale request. A fresh read reports the desired replica count observed after the request.

## Roll back a Helm release

Choose **Review Helm Rollback** on a release row. With Helm 4, select a superseded revision and review the resource changes listed by the server dry-run. Both revisions need the same set of supported namespaced resources. The operation skips chart hooks, and the review lists resource identities without printing manifest values.

An approved rollback checks both revision manifests again. After Helm completes, Rocketbrain looks for the new revision and checks its manifest against the selected revision. Another Helm client can change the release between these operations. Consult the current release history when Rocketbrain cannot confirm the resulting revision.
