package rocketbrain.signature;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import javax.tools.*;
import com.sun.source.tree.*;
import com.sun.source.util.*;

/** Owned read-only compiler attribution. No class generation, plugins or processors. */
public final class SignatureInspector {
    static final class Source extends SimpleJavaFileObject {
        final String text;
        Source(String uri, String text) { super(URI.create(uri), Kind.SOURCE); this.text = text; }
        public CharSequence getCharContent(boolean ignoreErrors) { return text; }
    }
    static String key(ExecutableElement method) {
        TypeElement owner = (TypeElement) method.getEnclosingElement();
        return owner.getQualifiedName() + "#" + method.getSimpleName() + "(" + String.join(",", method.getParameters().stream().map(p -> p.asType().toString()).toList()) + ")";
    }
    static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof Boolean || value instanceof Number) return value.toString();
        if (value instanceof Map<?, ?> map) return "{" + String.join(",", map.entrySet().stream().map(e -> json(e.getKey().toString()) + ":" + json(e.getValue())).toList()) + "}";
        if (value instanceof Collection<?> list) return "[" + String.join(",", list.stream().map(SignatureInspector::json).toList()) + "]";
        String s = value.toString(); StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c == '\\' || c == '"') out.append('\\').append(c); else if (c < 32) out.append(String.format("\\u%04x", (int)c)); else out.append(c); }
        return out.append('"').toString();
    }
    static Map<String, Object> object(Object... values) {
        Map<String, Object> map = new LinkedHashMap<>(); for (int i = 0; i < values.length; i += 2) map.put((String) values[i], values[i + 1]); return map;
    }
    static List<Map<String,Object>> typeParameters(List<? extends TypeParameterElement> parameters) {
        return parameters.stream().map(p -> object("name",p.getSimpleName().toString(),"bounds",p.getBounds().stream().map(Object::toString).toList())).toList();
    }
    static final class Method {
        ExecutableElement element; MethodTree tree; CompilationUnitTree unit; String uri; long start, end, nameStart;
        Map<String, Object> model; List<Map<String, Object>> parameters = new ArrayList<>(); Set<String> identifiers = new TreeSet<>();
    }
    static boolean safeArgument(TreePath parent, ExpressionTree value, Trees trees) {
        if (value instanceof LiteralTree) return true;
        if (value instanceof UnaryTree unary && unary.getKind() == Tree.Kind.UNARY_MINUS && unary.getExpression() instanceof LiteralTree) return true;
        if (value instanceof IdentifierTree) {
            Element element = trees.getElement(new TreePath(parent, value));
            return element instanceof VariableElement variable && (Set.of(ElementKind.LOCAL_VARIABLE, ElementKind.PARAMETER, ElementKind.EXCEPTION_PARAMETER, ElementKind.RESOURCE_VARIABLE).contains(variable.getKind()) || variable.getConstantValue() != null);
        }
        return false;
    }
    public static void main(String[] args) throws Exception {
        if (args.length != 4) throw new IllegalArgumentException("Use classpath-file, source-list, empty-provider-path and release.");
        String classpath = Files.readString(Path.of(args[0]), StandardCharsets.UTF_8);
        List<Source> sources = new ArrayList<>(); Map<String, Source> byUri = new HashMap<>();
        for (String line : Files.readAllLines(Path.of(args[1]), StandardCharsets.UTF_8)) {
            String[] parts = line.split("\t", -1); if (parts.length != 2 || sources.size() >= 500) throw new IllegalArgumentException("Invalid bounded source list.");
            Source source = new Source(parts[0], new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8)); sources.add(source); byUri.put(source.toUri().toString(), source);
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler(); if (compiler == null) throw new IllegalStateException("A full independent JDK is required.");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        try (StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            JavaFileManager files = new ForwardingJavaFileManager<StandardJavaFileManager>(standard) {
                public JavaFileObject getJavaFileForOutput(Location location, String name, JavaFileObject.Kind kind, FileObject sibling) throws IOException { throw new IOException("Class generation is disabled."); }
            };
            List<String> options = List.of("-proc:none", "-implicit:none", "-Xlint:none", "-encoding", "UTF-8", "-sourcepath", args[2], "-processorpath", args[2], "-classpath", classpath, "--release", args[3]);
            StringWriter compilerOutput = new StringWriter();
            JavacTask task = (JavacTask) compiler.getTask(compilerOutput, files, diagnostics, options, null, sources);
            List<CompilationUnitTree> units = new ArrayList<>(); task.parse().forEach(units::add); task.analyze();
            Trees trees = Trees.instance(task); Elements elements = task.getElements(); Types types=task.getTypes(); SourcePositions positions = trees.getSourcePositions();
            List<Method> methods = new ArrayList<>(); List<Map<String, Object>> calls = new ArrayList<>(); List<Map<String, Object>> references = new ArrayList<>();
            for (CompilationUnitTree unit : units) {
                String uri = unit.getSourceFile().toUri().toString(), text = byUri.get(uri).text;
                new TreePathScanner<Void, Void>() {
                    Method current; int ordinal;
                    public Void visitMethod(MethodTree tree, Void p) {
                        Element element = trees.getElement(getCurrentPath()); if (!(element instanceof ExecutableElement executable)) return super.visitMethod(tree,p);
                        long start = positions.getStartPosition(unit, tree), end = positions.getEndPosition(unit, tree); if (start < 0 || end < start) return super.visitMethod(tree,p);
                        TypeElement owner = (TypeElement) executable.getEnclosingElement(); Method method = new Method(); method.element = executable; method.tree = tree; method.unit = unit; method.uri = uri; method.start = start; method.end = end;
                        String name = executable.getKind() == ElementKind.CONSTRUCTOR ? owner.getSimpleName().toString() : executable.getSimpleName().toString();
                        long headerEnd = tree.getBody() == null ? end : positions.getStartPosition(unit, tree.getBody());
                        int open = tree.getParameters().isEmpty() ? text.lastIndexOf('(', (int)headerEnd) : text.lastIndexOf('(', (int)positions.getStartPosition(unit, tree.getParameters().getFirst()));
                        int cursor = open; while (cursor > start && Character.isWhitespace(text.charAt(cursor - 1))) cursor--;
                        int nameAt = cursor - name.length(); method.nameStart = nameAt >= start && text.regionMatches(nameAt, name, 0, name.length()) ? nameAt : -1;
                        for (VariableElement variable : executable.getParameters()) method.parameters.add(object("type", variable.asType().toString(), "erasure", types.erasure(variable.asType()).toString(), "name", variable.getSimpleName().toString(), "used", false, "annotated", !variable.getAnnotationMirrors().isEmpty() || !variable.asType().getAnnotationMirrors().isEmpty()));
                        method.model = object("key", key(executable), "uri", uri, "owner", owner.getQualifiedName().toString(), "ownerKind", owner.getKind().toString(), "name", name, "constructor", executable.getKind() == ElementKind.CONSTRUCTOR, "start", start, "end", end, "nameStart", method.nameStart, "parameters", method.parameters, "returnType", executable.getReturnType().toString(), "throwsTypes", executable.getThrownTypes().stream().map(Object::toString).toList(), "modifiers", executable.getModifiers().stream().map(Object::toString).sorted().toList(), "annotations", executable.getAnnotationMirrors().stream().map(a -> a.getAnnotationType().toString()).toList(), "generic", !owner.getTypeParameters().isEmpty() || !executable.getTypeParameters().isEmpty(), "varargs", executable.isVarArgs());
                        method.model.put("typeParameters",typeParameters(executable.getTypeParameters()));
                        method.model.put("ownerTypeParameters",typeParameters(owner.getTypeParameters()));
                        method.model.put("ownerSupertypes",types.directSupertypes(owner.asType()).stream().map(Object::toString).toList());
                        method.model.put("erasureKey",owner.getQualifiedName()+"#"+executable.getSimpleName()+"("+String.join(",",executable.getParameters().stream().map(v->types.erasure(v.asType()).toString()).toList())+")");
                        methods.add(method); Method previous=current; int previousOrdinal=ordinal; current=method; ordinal=0; Void result=super.visitMethod(tree,p); current=previous; ordinal=previousOrdinal; method.model.put("bodyIdentifiers", method.identifiers); return result;
                    }
                    public Void visitIdentifier(IdentifierTree tree, Void p) {
                        if (current != null && positions.getStartPosition(unit,tree)>=0) {
                            current.identifiers.add(tree.getName().toString()); Element element=trees.getElement(getCurrentPath());
                            for(int i=0;i<current.element.getParameters().size();i++) if(current.element.getParameters().get(i).equals(element)) current.parameters.get(i).put("used",true);
                        }
                        return super.visitIdentifier(tree,p);
                    }
                    void call(Tree tree, List<? extends ExpressionTree> arguments, boolean constructor) {
                        long start=positions.getStartPosition(unit,tree),end=positions.getEndPosition(unit,tree); Element element=trees.getElement(getCurrentPath());
                        if(start<0 || end<start || !(element instanceof ExecutableElement executable)) return;
                        calls.add(object("uri",uri,"start",start,"end",end,"methodKey",key(executable),"enclosingKey",current==null?"<initializer>":key(current.element),"ordinal",ordinal++,"constructor",constructor,"resultType",trees.getTypeMirror(getCurrentPath()).toString(),"safeArguments",arguments.stream().allMatch(v->safeArgument(getCurrentPath(),v,trees))));
                    }
                    public Void visitMethodInvocation(MethodInvocationTree tree, Void p) { call(tree,tree.getArguments(),false); return super.visitMethodInvocation(tree,p); }
                    public Void visitNewClass(NewClassTree tree, Void p) { call(tree,tree.getArguments(),true); return super.visitNewClass(tree,p); }
                    public Void visitMemberReference(MemberReferenceTree tree, Void p) {
                        Element e=trees.getElement(getCurrentPath()); if(e instanceof ExecutableElement method) references.add(object("uri",uri,"methodKey",key(method),"start",positions.getStartPosition(unit,tree))); return super.visitMemberReference(tree,p);
                    }
                }.scan(unit,null);
            }
            List<Map<String,Object>> edges=new ArrayList<>(); Set<String> external=new TreeSet<>();
            for(Method left:methods) {
                if(left.element.getKind()==ElementKind.CONSTRUCTOR)continue; TypeElement owner=(TypeElement)left.element.getEnclosingElement();
                for(Method right:methods) if(left!=right && right.element.getKind()!=ElementKind.CONSTRUCTOR && elements.overrides(left.element,right.element,owner)) edges.add(object("from",key(left.element),"to",key(right.element)));
                for(Element member:elements.getAllMembers(owner)) if(member instanceof ExecutableElement parent && parent.getKind()!=ElementKind.CONSTRUCTOR && !parent.equals(left.element) && elements.overrides(left.element,parent,owner) && trees.getPath(parent)==null) external.add(key(left.element));
                // getAllMembers hides overridden members; inspect every transitive supertype too.
                ArrayDeque<TypeElement> pending=new ArrayDeque<>(); Set<String> visited=new HashSet<>(); pending.add(owner);
                while(!pending.isEmpty()) {TypeElement type=pending.remove();if(!visited.add(type.getQualifiedName().toString()))continue;
                    for(var superType:task.getTypes().directSupertypes(type.asType())) {if(superType.getKind()!=TypeKind.DECLARED)continue; TypeElement parent=(TypeElement)task.getTypes().asElement(superType);pending.add(parent);
                        for(Element member:parent.getEnclosedElements()) if(member instanceof ExecutableElement parentMethod && parentMethod.getKind()!=ElementKind.CONSTRUCTOR && elements.overrides(left.element,parentMethod,owner) && trees.getPath(parentMethod)==null)external.add(key(left.element));
                    }
                }
            }
            List<Map<String,Object>> errors=diagnostics.getDiagnostics().stream().filter(d->d.getKind()==Diagnostic.Kind.ERROR).limit(30).map(d->object("uri",d.getSource()==null?null:d.getSource().toUri().toString(),"start",d.getStartPosition(),"end",d.getEndPosition(),"code",d.getCode(),"message",d.getMessage(Locale.ROOT))).toList();
            System.out.print(json(object("format","RocketbrainSignatureCompiler-v20","processorsEnabled",false,"classGenerationEnabled",false,"errors",errors,"methods",methods.stream().map(m->m.model).toList(),"calls",calls,"methodReferences",references,"overrideEdges",edges,"externalOverrides",external)));
        }
    }
}
