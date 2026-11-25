# Kubernetes and Helm explorer

Open **Kubernetes** in the Rocketbrain sidebar or run **Choose Kubernetes Context** in a trusted workspace. Rocketbrain uses installed `kubectl` and, optionally, Helm. Use PATH or set the absolute executable paths in **Rocketbrain › Kubernetes**.

Choose one kubeconfig file and confirm the context, HTTPS API address, account, and opening namespace. Rocketbrain uses a private snapshot of that context for the session. Changing the original file or kubectl's current context does not change the explorer's destination. Reconnect to use updated credentials. The selected context can use an embedded bearer token or client certificate and key with verified TLS. File-backed credentials, dynamic credential plugins, and kubeconfig proxies are outside this version. [Kubeconfig v1](https://kubernetes.io/docs/reference/config-api/kubeconfig.v1/)

- **Choose Kubernetes Namespace** uses the visible namespace list or accepts a name for accounts without permission to list namespaces. The tree shows deployment readiness, service ports, pod state, and current Helm release metadata for that namespace.
- Select a pod to open a timestamped log snapshot for one of its listed containers. Rocketbrain checks pod identity before and after reading up to 200 lines or 64 KiB. The read-only editor expires when you refresh, switch namespaces, or disconnect. [Kubectl logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/)
- Helm lists releases using its standard Secret storage in the selected namespace. This requires the account's permission to list Secrets there. Rocketbrain displays release name, status, chart and revision. [Helm list](https://helm.sh/docs/helm/helm_list/)

The workbench issues read requests only. Limit the supplied account through Kubernetes RBAC. Each list displays up to 200 rows with a count of rows omitted from the response. Resource edits, deployment, port forwarding, log streaming, and Helm install or upgrade remain outside this explorer.
