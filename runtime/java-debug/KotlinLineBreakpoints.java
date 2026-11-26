package com.microsoft.java.debug.core;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.microsoft.java.debug.core.adapter.IDebugAdapterContext;
import com.microsoft.java.debug.core.protocol.Messages;
import com.microsoft.java.debug.core.protocol.Types;
import com.sun.jdi.AbsentInformationException;
import com.sun.jdi.ClassNotPreparedException;
import com.sun.jdi.Location;
import com.sun.jdi.ReferenceType;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/** Resolves only saved source lines belonging to one managed JVM compilation. */
public final class KotlinLineBreakpoints {
    private static final String KOTLIN_ARGUMENT = "rocketbrainKotlinSourceLines";
    private static final String GROOVY_ARGUMENT = "rocketbrainGroovySourceLines";
    private static final int SOURCE_BYTES = 512 * 1024;
    private static final Map<IDebugAdapterContext, Session> SESSIONS =
            Collections.synchronizedMap(new WeakHashMap<>());

    private KotlinLineBreakpoints() {}

    public static void updateSession(IDebugAdapterContext context, Messages.Request request) {
        if ("disconnect".equals(request.command)) {
            SESSIONS.remove(context);
            return;
        }
        if (!"attach".equals(request.command)) return;
        SESSIONS.remove(context);
        if (request.arguments == null || !request.arguments.isJsonObject()) return;
        var arguments = request.arguments.getAsJsonObject();
        JsonElement argument = arguments.get(GROOVY_ARGUMENT);
        boolean groovy = argument != null && !argument.isJsonNull();
        if (!groovy) argument = arguments.get(KOTLIN_ARGUMENT);
        if (argument == null || argument.isJsonNull()) return;
        var packet = argument.getAsJsonObject();
        var format = groovy ? "RocketbrainGroovySourceLines1" : "RocketbrainKmpSourceLines1";
        if (!format.equals(string(packet, "format", 32))) throw invalid();
        var files = packet.getAsJsonArray("files");
        if (files == null || files.size() > 240) throw invalid();
        var session = new Session(groovy ? ".groovy" : ".kt");
        int total = 0;
        for (JsonElement file : files) {
            var value = file.getAsJsonObject();
            var path = physicalPath(string(value, "file", 2048));
            var name = string(value, "name", 256);
            var hash = hash(value, "sha256", false);
            if (!name.endsWith(session.suffix) ||
                    !name.substring(0, name.length() - session.suffix.length()).matches("[a-zA-Z_$][\\w$-]*") ||
                    !name.equals(path.getFileName().toString())) throw invalid();
            var source = new Source(path, name, hash);
            for (var row : value.getAsJsonObject("lines").entrySet()) {
                if (++total > 40000 || !row.getKey().matches("[1-9]\\d{0,5}")) throw invalid();
                int line = Integer.parseInt(row.getKey());
                var site = new Site(source, line, row.getValue().getAsJsonObject());
                if (groovy && !site.conventionalGroovy()) throw invalid();
                source.lines.put(line, site);
                var prior = session.owners.putIfAbsent(site.className(), source);
                if (prior != null && prior != source) throw invalid();
            }
            if (session.files.put(path, source) != null) throw invalid();
        }
        SESSIONS.put(context, session);
    }

    public static JavaBreakpointLocation[] locations(IDebugAdapterContext context, String fileName,
            Types.SourceBreakpoint[] requested, Types.SourceBreakpoint[] normalized, boolean sourceModified) {
        var session = SESSIONS.get(context);
        if (session == null || !fileName.toLowerCase(java.util.Locale.ROOT).endsWith(session.suffix)) return null;
        Source source = null;
        try { source = session.files.get(physicalPath(fileName)); } catch (IllegalArgumentException invalidPath) {
            // Unknown source paths never resolve in this managed compilation.
        }
        boolean clean = source != null && !sourceModified && source.isCurrent();
        var result = new JavaBreakpointLocation[normalized.length];
        for (int i = 0; i < normalized.length; i++) {
            int line = normalized[i].line;
            var input = requested[i];
            var row = clean && plain(input) ? source.lines.get(line) : null;
            result[i] = row == null ? new JavaBreakpointLocation(line, -1) : row;
        }
        return result;
    }

    public static boolean managed(JavaBreakpointLocation value) { return value instanceof Site; }

    public static Site frame(IDebugAdapterContext context, Location location) {
        var session = SESSIONS.get(context);
        if (session == null) return null;
        var type = location.declaringType();
        var source = session.owners.get(type.name());
        if (source == null || !source.isCurrent()) return null;
        for (String stratum : List.of("Kotlin", "Java")) {
            try {
                var site = source.lines.get(location.lineNumber(stratum));
                if (site != null && stratum.equals(site.stratum) && site.currentType(type)
                        && site.matches(location, false)) return site;
            } catch (AbsentInformationException | ClassNotPreparedException unavailable) {
                // Preserve upstream frame resolution when no live Kotlin source evidence matches.
            }
        }
        return null;
    }

    private static boolean plain(Types.SourceBreakpoint request) {
        return (request.condition == null || request.condition.isBlank())
                && (request.hitCondition == null || request.hitCondition.isBlank())
                && (request.logMessage == null || request.logMessage.isBlank());
    }

    private static Path physicalPath(String raw) {
        try {
            var path = (raw.startsWith("file:") ? Path.of(URI.create(raw)) : Path.of(raw)).normalize();
            if (!path.isAbsolute()) throw invalid();
            return path;
        } catch (IllegalArgumentException invalidPath) {
            throw invalid();
        }
    }

    private static IllegalArgumentException invalid() { return new IllegalArgumentException("Invalid owned JVM source-line evidence."); }

    private static String string(JsonObject object, String key, int limit) {
        var value = object.get(key);
        if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) throw invalid();
        var text = value.getAsString();
        if (text.length() > limit || text.chars().anyMatch(code -> code < 32 || code == 127)) throw invalid();
        return text;
    }

    private static String hash(JsonObject object, String key, boolean optional) {
        var value = string(object, key, 64);
        if (!(optional && value.isEmpty()) && !value.matches("[a-f0-9]{64}")) throw invalid();
        return value;
    }

    private static String sha256(byte[] bytes) {
        try {
            var hex = new StringBuilder(64);
            for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) {
                hex.append(Character.forDigit((value >> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static final class Session {
        final String suffix;
        final Map<Path, Source> files = new HashMap<>();
        final Map<String, Source> owners = new HashMap<>();

        Session(String suffix) { this.suffix = suffix; }
    }

    private static final class Source {
        final Path file;
        final String name;
        final String hash;
        final Map<Integer, Site> lines = new HashMap<>();

        Source(Path file, String name, String hash) { this.file = file; this.name = name; this.hash = hash; }

        boolean isCurrent() {
            try {
                if (!file.equals(file.toRealPath()) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)
                        || Files.size(file) > SOURCE_BYTES) return false;
                try (var stream = Files.newInputStream(file)) {
                    var bytes = stream.readNBytes(SOURCE_BYTES + 1);
                    return bytes.length <= SOURCE_BYTES && hash.equals(sha256(bytes));
                }
            } catch (IOException | SecurityException unavailable) {
                return false;
            }
        }
    }

    public static final class Site extends JavaBreakpointLocation {
        private final Source source;
        private final int line;
        private final int bci;
        private final String method;
        private final String signature;
        private final String code;
        private final String stratum;
        private final String debugHash;
        private final String jdiPath;

        private Site(Source source, int line, JsonObject evidence) {
            super(line, -1);
            this.source = source;
            this.line = line;
            this.bci = evidence.get("bci").getAsInt();
            this.method = string(evidence, "method", 256);
            this.signature = string(evidence, "signature", 512);
            this.code = hash(evidence, "code", false);
            this.stratum = string(evidence, "stratum", 8);
            this.debugHash = hash(evidence, "debugSha256", true);
            String owner = string(evidence, "owner", 256);
            if (!owner.matches("[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*") || bci < 0 || bci > 65535
                    || !("Kotlin".equals(stratum) || "Java".equals(stratum))) throw invalid();
            this.setClassName(owner);
            int separator = owner.lastIndexOf('.');
            this.jdiPath = "Kotlin".equals(stratum) ? string(evidence, "path", 512)
                    : (separator < 0 ? "" : owner.substring(0, separator).replace('.', '/') + "/") + source.name;
        }

        public List<Location> resolve(List<ReferenceType> candidates) {
            if (!source.isCurrent()) return List.of();
            for (var type : candidates) {
                try {
                    if (!currentType(type)) continue;
                    for (var location : type.locationsOfLine(stratum, source.name, line)) {
                        if (matches(location, true)) return List.of(location);
                    }
                } catch (AbsentInformationException | ClassNotPreparedException unavailable) {
                    // A line without matching live debug information remains unverified.
                }
            }
            return List.of();
        }

        public Types.Source clientSource(IDebugAdapterContext context) {
            return new Types.Source(source.name, context.isClientPathsAreUri() ? source.file.toUri().toString() : source.file.toString(), 0);
        }

        private boolean conventionalGroovy() {
            return "Java".equals(stratum) && debugHash.isEmpty() &&
                    className().substring(className().lastIndexOf('.') + 1).concat(".groovy").equals(source.name);
        }

        private boolean currentType(ReferenceType type) throws AbsentInformationException {
            return className().equals(type.name()) && type.isPrepared() && type.virtualMachine().canGetBytecodes()
                    && type.virtualMachine().classesByName(type.name()).size() == 1 && type.availableStrata().contains(stratum)
                    && (!"Kotlin".equals(stratum) || debugHash.equals(
                            sha256(type.sourceDebugExtension().getBytes(StandardCharsets.UTF_8))));
        }

        private boolean matches(Location location, boolean exactIndex) throws AbsentInformationException {
            return (exactIndex ? location.codeIndex() == bci : location.codeIndex() >= bci)
                    && location.lineNumber(stratum) == line && location.sourceName(stratum).equals(source.name)
                    && location.sourcePath(stratum).replace('\\', '/').equals(jdiPath)
                    && method.equals(location.method().name()) && signature.equals(location.method().signature())
                    && code.equals(sha256(location.method().bytecodes()));
        }
    }
}
