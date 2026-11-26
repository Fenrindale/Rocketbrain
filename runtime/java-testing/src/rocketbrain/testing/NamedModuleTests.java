package rocketbrain.testing;

import java.lang.module.ModuleFinder;
import java.lang.module.ModuleReference;
import java.net.URI;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.ServiceLoader;
import org.junit.platform.engine.DiscoverySelector;
import org.junit.platform.engine.TestEngine;
import org.junit.platform.engine.UniqueId;
import org.junit.platform.engine.discovery.DiscoverySelectors;
import org.junit.platform.engine.support.descriptor.ClassSource;
import org.junit.platform.engine.support.descriptor.MethodSource;
import org.junit.platform.launcher.Launcher;
import org.junit.platform.launcher.TestIdentifier;
import org.junit.platform.launcher.TestPlan;
import org.junit.platform.launcher.core.LauncherConfig;
import org.junit.platform.launcher.core.LauncherFactory;

/** Validates the boot layer and limits Jupiter to one explicitly named test module. */
final class NamedModuleTests {
    private static final String ENGINE_MODULE = "org.junit.jupiter.engine";
    private static final String ENGINE_ID = "junit-jupiter";
    private final Module testModule;

    private NamedModuleTests(Module testModule) {
        this.testModule = testModule;
    }

    static NamedModuleTests open() {
        String name = Runner.value("testModule");
        var layer = ModuleLayer.boot();
        var module = layer.findModule(name).orElseThrow(() -> new IllegalArgumentException("The selected named test module was not resolved."));
        if (!module.isNamed() || module.getDescriptor().isAutomatic() || !module.canRead(org.junit.jupiter.api.Test.class.getModule())) {
            throw new IllegalArgumentException("Compile the selected named test output with a read on Jupiter's API.");
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
            var reference = choices.iterator().next();
            var description = reference.descriptor();
            String found = description.name();
            if (!names.add(found)) throw new IllegalArgumentException("The named test path contains a duplicate module.");
            if ((!expected.isEmpty() && !expected.equals(found)) ||
                    (found.startsWith("org.junit.") || found.equals("junit") || found.equals("org.testng") ||
                         found.equals("org.opentest4j") || found.equals("org.apiguardian.api")) && expected.isEmpty() ||
                    !found.equals(ENGINE_MODULE) && description.provides().stream()
                        .anyMatch(provider -> provider.service().equals(TestEngine.class.getName()))) {
                throw new IllegalArgumentException("The named test path contains an unreviewed test engine or framework module.");
            }
            if (!expected.isEmpty() && (!optional || layer.findModule(found).isPresent())) {
                checkLocation(layer, found, file);
            }
        }
        checkLocation(layer, name, Path.of(URI.create(Runner.value("testModuleOutput"))));
        var engine = layer.findModule(ENGINE_MODULE).orElseThrow();
        String version = engine.getDescriptor().rawVersion().orElse("");
        if (!"6.0.3".equals(version)) throw new IllegalArgumentException("The boot layer did not resolve the pinned Jupiter 6.0.3 engine.");
        Runner.emit(Runner.map("type", "module", "name", name, "engine", ENGINE_ID, "version", version, "entries", count));
        return new NamedModuleTests(module);
    }

    private static void checkLocation(ModuleLayer layer, String name, Path file) {
        ModuleReference resolved = layer.configuration().findModule(name)
            .orElseThrow(() -> new IllegalArgumentException("A reviewed module is unavailable in the boot layer.")).reference();
        if (resolved.location().isEmpty() || !file.equals(Path.of(resolved.location().orElseThrow()))) {
            throw new IllegalArgumentException("A resolved JVM module did not come from its reviewed path entry.");
        }
    }

    Launcher launcher() {
        var engines = ServiceLoader.load(ModuleLayer.boot(), TestEngine.class).stream()
            .filter(provider -> ENGINE_MODULE.equals(provider.type().getModule().getName()))
            .toList();
        if (engines.size() != 1) throw new IllegalArgumentException("The pinned named Jupiter engine was not uniquely resolved.");
        TestEngine engine = engines.getFirst().get();
        if (!ENGINE_ID.equals(engine.getId())) throw new IllegalArgumentException("The resolved named test engine differs from Jupiter.");
        return LauncherFactory.create(LauncherConfig.builder()
            .enableTestEngineAutoRegistration(false).enableLauncherDiscoveryListenerAutoRegistration(false)
            .enableLauncherSessionListenerAutoRegistration(false).enablePostDiscoveryFilterAutoRegistration(false)
            .enableTestExecutionListenerAutoRegistration(false).addTestEngines(engine).build());
    }

    DiscoverySelector all() {
        return DiscoverySelectors.selectModule(testModule.getName());
    }

    DiscoverySelector selector(String kind, String text) {
        return switch (kind) {
            case "class" -> DiscoverySelectors.selectClass(requireClass(text));
            case "method" -> {
                int separator = text.indexOf('#');
                if (separator < 1) throw new IllegalArgumentException("Select a method declared inside the named test module.");
                requireClass(text.substring(0, separator));
                yield DiscoverySelectors.selectMethod(text);
            }
            case "package" -> {
                if (!testModule.getPackages().contains(text)) throw new IllegalArgumentException("The selected package is outside the named test module.");
                yield DiscoverySelectors.selectPackage(text);
            }
            case "uniqueId" -> {
                UniqueId identifier = verifyId(text);
                yield identifier.getSegments().size() == 1 ? all() : DiscoverySelectors.selectUniqueId(identifier);
            }
            default -> throw new IllegalArgumentException("Unsupported named test selector.");
        };
    }

    UniqueId verifyId(String text) {
        var identifier = UniqueId.parse(text);
        if (!identifier.getEngineId().filter(ENGINE_ID::equals).isPresent()) {
            throw new IllegalArgumentException("The selected test does not belong to the pinned named Jupiter engine.");
        }
        if (identifier.getSegments().size() > 1) {
            var first = identifier.getSegments().get(1);
            if (!"class".equals(first.getType())) throw new IllegalArgumentException("Select a class in the reviewed named test module.");
            requireClass(first.getValue());
        }
        return identifier;
    }

    void verifyPlan(TestPlan plan) {
        for (TestIdentifier root : plan.getRoots()) {
            verifyId(root.getUniqueId());
            for (TestIdentifier item : plan.getDescendants(root)) {
                var source = item.getSource().orElse(null);
                if (source instanceof ClassSource type) requireClass(type.getClassName());
                else if (source instanceof MethodSource method) requireClass(method.getClassName());
                else if (item.isTest()) throw new IllegalArgumentException("A discovered test has no class in the selected named module.");
            }
        }
    }

    private Class<?> requireClass(String name) {
        if (name.length() > 512 || !name.matches("[\\p{L}_$][\\p{L}\\p{N}_$.]*")) {
            throw new IllegalArgumentException("Invalid Java test class.");
        }
        Class<?> type = Class.forName(testModule, name);
        if (type == null || type.getModule() != testModule) {
            throw new IllegalArgumentException("The selected Java test is outside " + testModule.getName() + ".");
        }
        return type;
    }
}
