import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
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
        server.getHost().setAutoDeploy(false);
        server.getHost().setDeployOnStartup(false);
        server.getServer().setPort(-1);
        var connector = new Connector("HTTP/1.1");
        connector.setProperty("address", "127.0.0.1");
        connector.setPort(0);
        server.setConnector(connector);
        String contextPath = "/" + args[1];
        Path war = Path.of(args[2]);
        Context context = server.addWebapp(contextPath, war.toString());
        try {
            server.start();
            int port = connector.getLocalPort();
            if (!context.getState().isAvailable() || port <= 0) {
                throw new IllegalStateException("The WAR context or HTTP connector did not start.");
            }
            System.out.printf("rocketbrain-tomcat:%s:%s:%d%n", args[3], version, port);
            System.out.flush();
            // Closing the extension-owned stdin also stops the application.
            new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8)).readLine();
        } finally {
            try {
                server.stop();
            } finally {
                server.destroy();
            }
        }
    }
}
