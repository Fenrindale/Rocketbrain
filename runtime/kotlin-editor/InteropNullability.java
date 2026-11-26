import com.google.gson.Gson;
import com.sun.source.tree.AnnotatedTypeTree;
import com.sun.source.tree.AnnotationTree;
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.ParameterizedTypeTree;
import com.sun.source.tree.Tree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import javax.lang.model.element.Element;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.TypeElement;
import javax.tools.Diagnostic;
import javax.tools.DiagnosticCollector;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import org.jetbrains.kotlin.cli.common.arguments.K2JVMCompilerArguments;
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSeverity;
import org.jetbrains.kotlin.cli.common.messages.CompilerMessageSourceLocation;
import org.jetbrains.kotlin.cli.common.messages.MessageCollector;
import org.jetbrains.kotlin.cli.jvm.K2JVMCompiler;
import org.jetbrains.kotlin.config.Services;

class InteropNullability {
    private static final String ANNOTATIONS = "org.jspecify.annotations.";
    private static final List<String> CONTRACT_NAMES =
        List.of("Nullable", "NonNull", "NullMarked", "NullUnmarked");
    private static final Gson JSON = new Gson();

    record CompilerIssue(String path, int line, int column, int lineEnd, int columnEnd, String message) {}
    record CompilerResult(int exitCode, List<CompilerIssue> issues) {}
    record AnnotationSpan(int start, int end, String name) {}
    record Bound(int offset, boolean implicit) {}
    record JavaContract(int start, int headerEnd, String owner, String signature,
        List<AnnotationSpan> annotations, List<String> defaults, List<Bound> bounds) {}

    public static void main(String[] args) throws Exception {
        Object result = switch (args[0]) {
            case "compile" -> compile(Arrays.copyOfRange(args, 1, args.length));
            case "declaration" -> declaration(args);
            default -> throw new IllegalArgumentException("Unknown Kotlin nullability operation.");
        };
        System.out.write(("ROCKETBRAIN_NULLABILITY " + JSON.toJson(result) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private static CompilerResult compile(String[] args) {
        K2JVMCompiler compiler = new K2JVMCompiler();
        compiler.setReadingSettingsFromEnvironmentAllowed(false);
        K2JVMCompilerArguments options = compiler.createArguments();
        compiler.parseArguments(args, options);
        List<CompilerIssue> issues = new ArrayList<>();
        MessageCollector collector = new MessageCollector() {
            private boolean errors;

            @Override
            public void clear() {
                issues.clear();
                errors = false;
            }

            @Override
            public boolean hasErrors() {
                return errors;
            }

            @Override
            public void report(CompilerMessageSeverity severity, String message, CompilerMessageSourceLocation location) {
                if (!severity.isError()) return;
                errors = true;
                if (issues.size() >= 200 || message.length() > 2400) {
                    throw new IllegalArgumentException("Kotlin compilation exceeds its diagnostic limit.");
                }
                if (location == null) {
                    issues.add(new CompilerIssue("", -1, -1, -1, -1, message));
                } else {
                    issues.add(new CompilerIssue(location.getPath(), location.getLine(), location.getColumn(),
                        location.getLineEnd(), location.getColumnEnd(), message));
                }
            }
        };
        int exitCode = compiler.exec(collector, Services.EMPTY, options).getCode();
        return new CompilerResult(exitCode, issues);
    }

    private static List<JavaContract> declaration(String[] args) throws Exception {
        Path target = Path.of(args[1]);
        String classpath = args[2], sourcepath = args[3], name = args[4];
        int anchor = Integer.parseInt(args[5]);
        boolean ownerOnly = args[6].equals("owner");
        var javac = ToolProvider.getSystemJavaCompiler();
        var problems = new DiagnosticCollector<JavaFileObject>();
        try (var files = javac.getStandardFileManager(problems, null, StandardCharsets.UTF_8)) {
            var task = (JavacTask) javac.getTask(null, files, problems,
                List.of("-proc:none", "-implicit:none", "-classpath", classpath, "-sourcepath", sourcepath),
                null, files.getJavaFileObjects(target));
            var units = task.parse();
            task.analyze();
            if (problems.getDiagnostics().stream().anyMatch(problem -> problem.getKind() == Diagnostic.Kind.ERROR)) {
                throw new IllegalArgumentException("Javac could not attribute the selected Java declaration.");
            }
            if (task.getElements().getTypeElement(ANNOTATIONS + "NullUnmarked") == null) {
                throw new IllegalArgumentException("The observed classpath does not contain JSpecify.");
            }
            var trees = Trees.instance(task);
            List<JavaContract> contracts = new ArrayList<>();
            for (var unit : units) {
                new TreePathScanner<Void, Void>() {
                    @Override
                    public Void visitMethod(MethodTree method, Void ignored) {
                        if (!method.getName().contentEquals(name) ||
                            !(trees.getElement(getCurrentPath()) instanceof ExecutableElement executable) ||
                            !(executable.getEnclosingElement() instanceof TypeElement owner)) return null;
                        int start = start(trees, unit, method);
                        int headerEnd = method.getBody() == null ? end(trees, unit, method) :
                            start(trees, unit, method.getBody());
                        if (start < 0 || headerEnd <= start) return null;
                        if (ownerOnly) {
                            var ownerPath = getCurrentPath().getParentPath();
                            if (!(ownerPath.getLeaf() instanceof ClassTree owningClass) ||
                                !executable.getModifiers().contains(Modifier.STATIC)) return null;
                            int ownerStart = start(trees, unit, owningClass);
                            int firstMember = owningClass.getMembers().stream()
                                .filter(member -> end(trees, unit, member) >= 0)
                                .mapToInt(member -> start(trees, unit, member))
                                .filter(memberStart -> memberStart > ownerStart).min().orElse(start);
                            if (anchor < ownerStart || anchor >= firstMember) return null;
                        } else if (anchor < start || anchor >= headerEnd) return null;
                        List<AnnotationSpan> annotations = new ArrayList<>();
                        new TreePathScanner<Void, Void>() {
                            @Override
                            public Void visitAnnotation(AnnotationTree annotation, Void ignored) {
                                int from = start(trees, unit, annotation);
                                int to = end(trees, unit, annotation);
                                if (from >= start && to > from && to <= headerEnd) {
                                    Element element = trees.getElement(new com.sun.source.util.TreePath(
                                        getCurrentPath(), annotation.getAnnotationType()));
                                    if (element instanceof TypeElement annotationType) {
                                        String qualified = annotationType.getQualifiedName().toString();
                                        for (String kind : CONTRACT_NAMES) {
                                            if (qualified.equals(ANNOTATIONS + kind)) {
                                                annotations.add(new AnnotationSpan(from, to, qualified));
                                            }
                                        }
                                    }
                                }
                                return super.visitAnnotation(annotation, ignored);
                            }
                        }.scan(getCurrentPath(), null);
                        List<String> defaults = new ArrayList<>();
                        for (Element scope = executable; scope != null; scope = scope.getEnclosingElement()) {
                            for (var annotation : scope.getAnnotationMirrors()) {
                                String qualified = annotation.getAnnotationType().toString();
                                if (qualified.equals(ANNOTATIONS + "NullMarked") || qualified.equals(ANNOTATIONS + "NullUnmarked")) {
                                    defaults.add(qualified);
                                }
                            }
                        }
                        List<Bound> bounds = new ArrayList<>();
                        for (var parameter : method.getTypeParameters()) {
                            if (parameter.getBounds().isEmpty()) {
                                bounds.add(new Bound(end(trees, unit, parameter), true));
                            } else {
                                for (Tree bound : parameter.getBounds()) {
                                    bounds.add(new Bound(boundName(trees, unit, bound), false));
                                }
                            }
                        }
                        contracts.add(new JavaContract(start, headerEnd, owner.getQualifiedName().toString(),
                            executable.toString(), annotations, defaults, bounds));
                        return null;
                    }
                }.scan(unit, null);
            }
            return contracts;
        }
    }

    private static int boundName(Trees trees, CompilationUnitTree unit, Tree bound) {
        return switch (bound) {
            case AnnotatedTypeTree annotated -> boundName(trees, unit, annotated.getUnderlyingType());
            case ParameterizedTypeTree parameterized -> boundName(trees, unit, parameterized.getType());
            case MemberSelectTree qualified -> end(trees, unit, qualified) - qualified.getIdentifier().length();
            case IdentifierTree name -> start(trees, unit, name);
            default -> throw new IllegalArgumentException("Javac found an unsupported Java type bound.");
        };
    }

    private static int start(Trees trees, CompilationUnitTree unit, Tree tree) {
        return Math.toIntExact(trees.getSourcePositions().getStartPosition(unit, tree));
    }

    private static int end(Trees trees, CompilationUnitTree unit, Tree tree) {
        return Math.toIntExact(trees.getSourcePositions().getEndPosition(unit, tree));
    }
}
