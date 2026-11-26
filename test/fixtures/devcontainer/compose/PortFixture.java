import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public class PortFixture {
  public static void main(String[] args) throws Exception {
    int port = args.length == 0 ? 8787 : Integer.parseInt(args[0]);
    HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
    server.createContext("/ready", exchange -> {
      try (exchange) {
        byte[] response = "rocketbrain-container-http\n".getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, response.length);
        exchange.getResponseBody().write(response);
      }
    });
    server.start();
    System.out.println("Fixture HTTP listening on " + server.getAddress().getPort());
  }
}
