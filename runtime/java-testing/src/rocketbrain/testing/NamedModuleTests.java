package rocketbrain.testing;

import java.lang.module.ModuleFinder;
import java.lang.module.ModuleReference;
import java.net.URI;
import java.nio.file.Path;
import java.util.HashSet;

/** Checks the actual boot-layer artifacts before either framework can discover tests. */
final class NamedModuleTests {
    private static final String PLATFORM_SERVICE = "org.junit.platform.engine.TestEngine";
    private final Module testModule;
    private final Module engineModule;
    private final Path output;

    private NamedModuleTests(Module testModule, Module engineModule, Path output) {
        this.testModule = testModule;
        this.engineModule = engineModule;
        this.output = output;
    }

    static NamedModuleTests open() {
        boolean testng = Runner.value("framework").equals("testng");
        String engineId = testng ? "testng" : "junit-jupiter";
        String engineName = testng ? "org.testng" : "org.junit.jupiter.engine";
        String apiName = testng ? engineName : "org.junit.jupiter.api";
        String version = testng ? "7.11.0" : "6.0.3";
        String name = Runner.value("testModule");
        var layer = ModuleLayer.boot();
        var module = layer.findModule(name).orElseThrow(() -> new IllegalArgumentException("The selected named test module was not resolved."));
        var api = layer.findModule(apiName).orElseThrow(() -> new IllegalArgumentException("The selected named test framework API was not resolved."));
        if (!module.isNamed() || module.getDescriptor().isAutomatic() || !module.canRead(api)) {
            throw new IllegalArgumentException(testng ? "Declare requires org.testng in the selected named test module."
                : "Compile the selected named test output with a read on Jupiter's API.");
        }
        if (testng && module.getDescriptor().requires().stream().noneMatch(edge -> edge.name().equals(apiName))) {
            throw new IllegalArgumentException("Declare requires org.testng in the selected named test module.");
        }
        int count = Runner.number("moduleEntries");
        if (count < 1 || count > 80) throw new IllegalArgumentException("Invalid named test module path.");
        var names = new HashSet<String>();
        for (int index = 0; index < count; index++) {
            Path file = Path.of(URI.create(Runner.value("module." + index + ".uri")));
            String expected = Runner.value("module." + index + ".expected");
            boolean optional = Boolean.parseBoolean(Runner.value("module." + index + ".optional"));
            var choices = ModuleFinder.of(file).findAll();
            if (choices.size() != 1) throw new IllegalArgumentException("Every reviewed path entry must describe exactly one module.");
            var description = choices.iterator().next().descriptor();
            String found = description.name();
            if (!names.add(found)) throw new IllegalArgumentException("The named test path contains a duplicate module.");
            boolean framework = found.startsWith("org.junit.") || found.equals("junit") || found.equals("org.testng") ||
                found.equals("org.opentest4j") || found.equals("org.apiguardian.api");
            boolean foreignProvider = !found.equals(engineName) && description.provides().stream()
                .anyMatch(provider -> provider.service().equals(PLATFORM_SERVICE));
            if ((!expected.isEmpty() && !expected.equals(found)) || (framework && expected.isEmpty()) || foreignProvider) {
                throw new IllegalArgumentException("The named test path contains an unreviewed test engine or framework module.");
            }
            if (!expected.isEmpty() && (!optional || layer.findModule(found).isPresent())) {
                checkLocation(layer, found, file);
            }
        }
        Path output = Path.of(URI.create(Runner.value("testModuleOutput")));
        checkLocation(layer, name, output);
        var engine = layer.findModule(engineName).orElseThrow(() -> new IllegalArgumentException("The named test engine is unavailable."));
        if (!version.equals(engine.getDescriptor().rawVersion().orElse(""))) {
            throw new IllegalArgumentException("The boot layer did not resolve the pinned named test engine.");
        }
        Runner.emit(Runner.map("type", "module", "name", name, "engine", engineId, "version", version, "entries", count));
        return new NamedModuleTests(module, engine, output);
    }

    private static void checkLocation(ModuleLayer layer, String name, Path file) {
        ModuleReference resolved = layer.configuration().findModule(name)
            .orElseThrow(() -> new IllegalArgumentException("A reviewed module is unavailable in the boot layer.")).reference();
        if (resolved.location().isEmpty() || !file.equals(Path.of(resolved.location().orElseThrow()))) {
            throw new IllegalArgumentException("A resolved JVM module did not come from its reviewed path entry.");
        }
    }

    String name() { return testModule.getName(); }
    Path output() { return output; }
    boolean containsPackage(String name) { return testModule.getPackages().contains(name); }

    Class<?> requireClass(String name) {
        if (name.length() > 512 || !name.matches("[\\p{L}_$][\\p{L}\\p{N}_$.]*")) {
            throw new IllegalArgumentException("Invalid Java test class.");
        }
        Class<?> type = Class.forName(testModule, name);
        if (type == null || type.getModule() != testModule) {
            throw new IllegalArgumentException("The selected Java test is outside " + testModule.getName() + ".");
        }
        return type;
    }

    void requireTestNgAccess(Class<?> type) {
        if (type.getModule() != testModule) {
            throw new IllegalArgumentException("The selected TestNG method or provider is outside " + testModule.getName() + ".");
        }
        String packageName = type.getPackageName();
        var descriptor = testModule.getDescriptor();
        boolean declaredOpen = descriptor.isOpen() || descriptor.opens().stream().anyMatch(edge ->
            edge.source().equals(packageName) && (!edge.isQualified() || edge.targets().contains(engineModule.getName())));
        if (!declaredOpen || !testModule.isOpen(packageName, engineModule)) {
            throw new IllegalArgumentException("Declare opens " + packageName + " to org.testng in module-info.java.");
        }
    }
}
