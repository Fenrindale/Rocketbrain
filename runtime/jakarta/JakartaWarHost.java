import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import org.apache.catalina.Context;
import org.apache.catalina.connector.Connector;
import org.apache.catalina.startup.Tomcat;
import org.apache.catalina.util.ServerInfo;

class JakartaWarHost {
    public static void main(String[] args) throws Exception {
        String version = ServerInfo.getServerNumber();
        if (!version.matches("11\\.0\\.\\d+(?:\\.\\d+)?")) {
            throw new IllegalStateException("Choose an Apache Tomcat 11 distribution; found " + version);
        }
        var server = new Tomcat();
        server.setBaseDir(args[0]);
        Files.createDirectories(Path.of(args[0], "webapps"));
        var host = server.getHost();
        host.setAutoDeploy(false);
        host.setDeployOnStartup(false);
        server.getServer().setPort(-1);
        var connector = new Connector("HTTP/1.1");
        connector.setProperty("address", "127.0.0.1");
        connector.setPort(0);
        server.setConnector(connector);

        String token = args[1];
        Map<String, Context> applications = new LinkedHashMap<>();
        try {
            for (int index = 2; index < args.length; index += 2) {
                String name = args[index];
                applications.put(name, server.addWebapp("/" + name, args[index + 1]));
            }
            server.start();
            int port = connector.getLocalPort();
            if (port <= 0 || applications.values().stream().anyMatch(app -> !app.getState().isAvailable())) {
                throw new IllegalStateException("A reviewed WAR context or the HTTP connector did not start.");
            }
            System.out.printf("rocketbrain-tomcat:%s:%s:%d%n", token, version, port);
            System.out.flush();

            // An extension-owned pipe handles removal and shuts the server down on EOF.
            var input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = input.readLine()) != null) {
                if (line.isEmpty()) break;
                String[] fields = line.split(" ", -1);
                if (fields.length != 3 || !fields[0].equals("remove") || !fields[1].matches("[a-f0-9-]{36}")) {
                    throw new IllegalArgumentException("Invalid Tomcat management message.");
                }
                String name = fields[2];
                Context app = applications.get(name);
                if (app == null || host.findChild(app.getName()) != app) {
                    throw new IllegalStateException("The reviewed Tomcat context has changed.");
                }
                host.removeChild(app);
                if (app.getState().isAvailable() || host.findChild(app.getName()) != null) {
                    throw new IllegalStateException("Tomcat did not confirm removal of the reviewed context.");
                }
                applications.remove(name);
                System.out.printf("rocketbrain-tomcat:%s:removed:%s:%s%n", token, fields[1], name);
                System.out.flush();
            }
        } finally {
            try {
                server.stop();
            } finally {
                server.destroy();
            }
        }
    }
}
