import javafx.application.Platform;
import javafx.fxml.FXMLLoader;
import javafx.geometry.Bounds;
import javafx.scene.Group;
import javafx.scene.Node;
import javafx.scene.Parent;
import javafx.scene.Scene;
import javafx.scene.image.PixelFormat;
import javafx.scene.image.WritableImage;
import javafx.scene.paint.Color;
import java.awt.image.BufferedImage;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

class FxmlPreview {
    public static void main(String[] args) throws Exception {
        Path file = Path.of(args[0]), output = Path.of(args[1]);
        int width = dimension(args[2]), height = dimension(args[3]);
        var targetIds = Files.readAllLines(Path.of(args[4]));
        if (targetIds.size() > 128) throw new IllegalArgumentException("Too many FXML property targets.");
        CompletableFuture<Void> rendered = new CompletableFuture<>();
        Platform.startup(() -> {});
        Platform.runLater(() -> {
            try {
                FXMLLoader loader = new FXMLLoader(file.toUri().toURL());
                loader.setControllerFactory(type -> {
                    throw new IllegalArgumentException("User controllers are outside the FXML preview.");
                });
                Object loaded = loader.load();
                if (!(loaded instanceof Node node)) throw new IllegalArgumentException("FXML preview requires a JavaFX node.");
                Parent root = node instanceof Parent parent ? parent : new Group(node);
                Scene scene = new Scene(root, width, height, Color.WHITE);
                root.applyCss();
                root.layout();
                WritableImage snapshot = scene.snapshot(null);
                int[] pixels = new int[width * height];
                snapshot.getPixelReader().getPixels(0, 0, width, height, PixelFormat.getIntArgbInstance(), pixels, 0, width);
                BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_ARGB);
                image.setRGB(0, 0, width, height, pixels, 0, width);
                try (var stream = Files.newOutputStream(output, StandardOpenOption.CREATE_NEW)) {
                    if (!ImageIO.write(image, "png", stream)) throw new IllegalStateException("PNG output is unavailable.");
                }
                for (String id : targetIds) {
                    if (!id.matches("[A-Za-z_$][\\w$]{0,95}")) throw new IllegalArgumentException("Invalid FXML target.");
                    Object target = loader.getNamespace().get(id);
                    if (target instanceof Node candidate && candidate.getScene() == scene) {
                        targetBounds(id, candidate, width, height);
                    }
                }
                rendered.complete(null);
            } catch (Throwable problem) {
                rendered.completeExceptionally(problem);
            }
        });
        try {
            rendered.get(25, TimeUnit.SECONDS);
            System.out.println("Rocketbrain FXML Preview " + System.getProperty("javafx.runtime.version"));
        } finally {
            Platform.exit();
        }
    }

    private static void targetBounds(String id, Node node, int width, int height) {
        for (Node ancestor = node; ancestor != null; ancestor = ancestor.getParent()) {
            if (!ancestor.isVisible() || ancestor.getOpacity() == 0 || ancestor.getClip() != null) return;
        }
        Bounds bounds = node.localToScene(node.getBoundsInLocal());
        if (bounds == null || bounds.isEmpty()) return;
        double[] edges = {bounds.getMinX(), bounds.getMinY(), bounds.getMaxX(), bounds.getMaxY()};
        for (double value : edges) if (!Double.isFinite(value)) return;
        int x = (int)Math.max(0, Math.floor(edges[0])), y = (int)Math.max(0, Math.floor(edges[1]));
        int right = (int)Math.min(width, Math.ceil(edges[2])), bottom = (int)Math.min(height, Math.ceil(edges[3]));
        if (right > x && bottom > y) {
            System.out.printf("RB_FRAME_TARGET\t%s\t%d\t%d\t%d\t%d%n", id, x, y, right - x, bottom - y);
        }
    }

    private static int dimension(String value) {
        int result = Integer.parseInt(value);
        if (result < 32 || result > 1024) throw new IllegalArgumentException("Invalid FXML preview dimensions.");
        return result;
    }
}
