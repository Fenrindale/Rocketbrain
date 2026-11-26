package rocketbrain.signature;

import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
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
    static String hiddenAccessNest(TypeElement owner) {
        if (owner.getKind() != ElementKind.CLASS || owner.getNestingKind() != NestingKind.MEMBER ||
                !owner.getModifiers().containsAll(Set.of(Modifier.PRIVATE, Modifier.STATIC, Modifier.FINAL)) ||
                !owner.getSuperclass().toString().equals("java.lang.Object") || !owner.getInterfaces().isEmpty()) return null;
        for (Element current = owner; current instanceof TypeElement type; current = type.getEnclosingElement()) {
            if (!type.getAnnotationMirrors().isEmpty()) return null;
            if (type.getNestingKind() == NestingKind.TOP_LEVEL) return type.getQualifiedName().toString();
            if (type.getNestingKind() != NestingKind.MEMBER) return null;
        }
        return null;
    }
    static List<String> checkedThrownTypes(ExecutableElement method, Types types, Elements elements) {
        if (method.getThrownTypes().isEmpty()) return List.of();
        TypeMirror throwable = elements.getTypeElement("java.lang.Throwable").asType();
        TypeMirror unchecked = elements.getTypeElement("java.lang.RuntimeException").asType();
        TypeMirror error = elements.getTypeElement("java.lang.Error").asType();
        return method.getThrownTypes().stream().filter(type -> type.getKind() == TypeKind.DECLARED &&
            types.isSubtype(type, throwable) && !types.isSubtype(type, unchecked) && !types.isSubtype(type, error))
            .map(TypeMirror::toString).toList();
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
    static List<Map<String,Object>> errors(DiagnosticCollector<JavaFileObject> diagnostics) {
        return diagnostics.getDiagnostics().stream().filter(d -> d.getKind() == Diagnostic.Kind.ERROR).limit(30)
            .map(d -> object("uri",d.getSource() == null ? null : d.getSource().toUri().toString(),
                "start",d.getStartPosition(),"end",d.getEndPosition(),"code",d.getCode(),"message",d.getMessage(Locale.ROOT))).toList();
    }

    static Map<String,Object> location(CompilationUnitTree unit, Tree node, SourcePositions positions) {
        return object("uri",unit.getSourceFile().toUri().toString(),"start",positions.getStartPosition(unit,node),
            "end",positions.getEndPosition(unit,node));
    }

    static List<Map<String,Object>> diagrams(List<CompilationUnitTree> units, Trees trees, Types types) {
        SourcePositions positions = trees.getSourcePositions();
        List<Map<String,Object>> declarations = new ArrayList<>();
        int[] relationshipBudget = {9000};
        for (var unit : units) {
            new TreePathScanner<Void,Void>() {
                @Override public Void visitClass(ClassTree node, Void unused) {
                    var bound = trees.getElement(getCurrentPath());
                    if (!(bound instanceof TypeElement declared) ||
                            (declared.getNestingKind() != NestingKind.TOP_LEVEL && declared.getNestingKind() != NestingKind.MEMBER)) {
                        return super.visitClass(node,unused);
                    }
                    List<Map<String,Object>> members = new ArrayList<>(), relations = new ArrayList<>();
                    int omittedMembers = 0;
                    for (var parent : types.directSupertypes(declared.asType())) {
                        if (!(types.asElement(parent) instanceof TypeElement owner)) continue;
                        boolean contract = owner.getKind().isInterface();
                        if (!contract && node.getExtendsClause() == null) continue;
                        relations.add(object("target",owner.getQualifiedName().toString(),
                            "kind",contract && !declared.getKind().isInterface() ? "implements" : "extends",
                            "signature",parent.toString()));
                    }
                    Element enclosing = declared.getEnclosingElement();
                    if (enclosing instanceof TypeElement container) {
                        relations.add(object("target",container.getQualifiedName().toString(),"kind","nestedIn",
                            "signature",container.getQualifiedName().toString()));
                    }
                    for (var member : declared.getEnclosedElements()) {
                        var memberPath = trees.getPath(member);
                        if (memberPath == null) continue;
                        var ownerUnit = memberPath.getCompilationUnit();
                        var declaration = memberPath.getLeaf();
                        var anchor = location(ownerUnit,declaration,positions);
                        if ((long) anchor.get("start") < 0 || (long) anchor.get("end") < 0) continue;
                        if (members.size() >= 80) { omittedMembers++; continue; }
                        if (member instanceof VariableElement field && field.getKind().isField()) {
                            members.add(object("name",field.getSimpleName().toString(),"signature",field.asType().toString(),
                                "kind","field","modifiers",modifiers(field),"location",anchor));
                        } else if (member instanceof ExecutableElement method) {
                            boolean ctor = method.getKind() == ElementKind.CONSTRUCTOR;
                            String memberName = ctor ? declared.getSimpleName().toString() : method.getSimpleName().toString();
                            members.add(object("name",memberName,"signature",memberName + "(" +
                                String.join(", ",method.getParameters().stream().map(p -> p.asType().toString()).toList()) + ")"
                                + (ctor ? "" : " : " + method.getReturnType()),
                                "kind",ctor ? "constructor" : "method","modifiers",modifiers(method),"location",anchor));
                        }
                    }
                    int structuralCount=relations.size();
                    int omittedRelations=new JavaDiagramRelations(trees,declared,relations,relationshipBudget[0]).inspect(getCurrentPath());
                    relationshipBudget[0]-=relations.size()-structuralCount;
                    declarations.add(object("id",declared.getQualifiedName().toString(),
                        "name",declared.getSimpleName().toString(),"kind",declared.getKind().toString(),
                        "modifiers",modifiers(declared),"location",location(unit,node,positions),
                        "relations",relations,"members",members,"omittedMembers",omittedMembers,"omittedRelations",omittedRelations));
                    if (declarations.size() > 300) throw new IllegalArgumentException("Java diagram declaration limit");
                    return super.visitClass(node,unused);
                }
            }.scan(unit,null);
        }
        return declarations;
    }

    static List<String> modifiers(Element element) {
        return element.getModifiers().stream().map(Object::toString).sorted().toList();
    }

    static final class Flow {
        record Value(List<Integer> inputs, Object fact) {}
        record Event(int id, String kind, String name, int start, int end, List<Integer> inputs,
                     String uri, String method, int frame) {
            Map<String,Object> output(boolean acrossCalls) {
                var result = object("id",id,"kind",kind,"name",name,"start",start,"end",end,"inputs",inputs);
                if (acrossCalls) result.putAll(object("uri",uri,"method",method,"frame",frame));
                return result;
            }
        }
        interface Calls {
            Value invoke(Flow owner, TreePath at, MethodInvocationTree call);
        }
        final Map<Element,Integer> definitions = new LinkedHashMap<>();
        final List<Event> events;
        final Map<Integer,Object> facts;
        final CompilationUnitTree unit;
        final Trees trees;
        final SourcePositions positions;
        final String text;
        final String method;
        final int frame;
        final Calls calls;
        List<Integer> controls = List.of();

        Flow(CompilationUnitTree unit, Trees trees, String text) {
            this(unit,trees,text,new ArrayList<>(),new HashMap<>(),"",0,null);
        }

        Flow(CompilationUnitTree unit, Trees trees, String text, List<Event> events, Map<Integer,Object> facts,
             String method, int frame, Calls calls) {
            this.unit = unit;
            this.trees = trees;
            this.positions = trees.getSourcePositions();
            this.text = text;
            this.events = events;
            this.facts = facts;
            this.method = method;
            this.frame = frame;
            this.calls = calls;
        }
        UnsupportedOperationException outsideScope() {
            return new UnsupportedOperationException("Trace a straight-line method with initialized local primitive or String values, simple assignments and returns.");
        }
        int add(String kind, String name, int start, int end, List<Integer> inputs) {
            if (events.size() >= 700 || start < 0 || end <= start || end > text.length()) throw outsideScope();
            int index = events.size();
            events.add(new Event(index,kind,name,start,end,List.copyOf(inputs),unit.getSourceFile().toUri().toString(),method,frame));
            return index;
        }
        int valueEvent(String kind, String name, int start, int end, List<Integer> inputs, Object fact) {
            int id = add(kind,name,start,end,inputs);
            if (calls != null && fact != FlowFacts.UNKNOWN) facts.put(id,fact);
            return id;
        }
        Object fact(int event) { return facts.getOrDefault(event,FlowFacts.UNKNOWN); }
        List<Integer> controlled(List<Integer> inputs) {
            if (controls.isEmpty()) return inputs;
            var union = new LinkedHashSet<>(inputs);
            union.addAll(controls);
            return List.copyOf(union);
        }
        int start(Tree node) { return (int) positions.getStartPosition(unit,node); }
        int end(Tree node) { return (int) positions.getEndPosition(unit,node); }

        VariableElement variable(TreePath route) {
            Element value = trees.getElement(route);
            if (!(value instanceof VariableElement local) ||
                    (local.getKind() != ElementKind.LOCAL_VARIABLE && local.getKind() != ElementKind.PARAMETER) ||
                    !scalar(local.asType())) {
                throw outsideScope();
            }
            return local;
        }

        int nameAt(VariableTree tree) {
            String name = tree.getName().toString();
            int low = start(tree);
            int until = tree.getInitializer() == null ? end(tree) : start(tree.getInitializer());
            if (low < 0 || until < low || until > text.length()) throw outsideScope();
            var matcher = java.util.regex.Pattern.compile("/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*|"
                + "\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*")
                .matcher(text);
            matcher.region(low,until);
            int found = -1;
            while (matcher.find()) if (matcher.group().equals(name)) found = matcher.start();
            if (found < 0) throw outsideScope();
            return found;
        }

        static boolean scalar(TypeMirror type) {
            return type.getKind().isPrimitive() || type.toString().equals("java.lang.String");
        }

        void declaration(TreePath at, VariableTree tree, boolean parameter, List<Integer> arguments) {
            VariableElement value = variable(at);
            int offset = nameAt(tree);
            if (!parameter && tree.getInitializer() == null) {
                if (calls == null) throw outsideScope();
                definitions.put(value,-1);
                return;
            }
            Value input = parameter ? new Value(arguments,arguments.isEmpty()?FlowFacts.UNKNOWN:fact(arguments.getFirst())) :
                expression(new TreePath(at,tree.getInitializer()));
            definitions.put(value,valueEvent(parameter?"parameter":"definition",value.getSimpleName().toString(),
                offset,offset+tree.getName().length(),controlled(input.inputs()),FlowFacts.stored(value.asType(),input.fact())));
        }

        Value expression(TreePath route) {
            Tree leaf = route.getLeaf();
            return switch (leaf.getKind()) {
                case BOOLEAN_LITERAL, CHAR_LITERAL, DOUBLE_LITERAL, FLOAT_LITERAL, INT_LITERAL, LONG_LITERAL,
                     STRING_LITERAL, NULL_LITERAL -> {
                    int from = start(leaf), to = end(leaf);
                    String value = text.substring(from,to);
                    Object fact = FlowFacts.literal(((LiteralTree)leaf).getValue());
                    yield new Value(List.of(valueEvent("literal",value.length()>60?value.substring(0,57)+"...":value,
                        from,to,controls,fact)),fact);
                }
                case IDENTIFIER -> {
                    VariableElement local = variable(route);
                    Integer from = definitions.get(local);
                    if (from == null || from < 0) throw outsideScope();
                    Object fact = fact(from);
                    yield new Value(List.of(valueEvent("read",local.getSimpleName().toString(),start(leaf),end(leaf),
                        controlled(List.of(from)),fact)),fact);
                }
                case PARENTHESIZED -> expression(new TreePath(route,((ParenthesizedTree) leaf).getExpression()));
                case TYPE_CAST -> {
                    Value input = expression(new TreePath(route,((TypeCastTree)leaf).getExpression()));
                    yield new Value(input.inputs(),FlowFacts.cast(trees.getTypeMirror(route),input.fact()));
                }
                case METHOD_INVOCATION -> {
                    if (calls == null) throw outsideScope();
                    yield calls.invoke(this,route,(MethodInvocationTree) leaf);
                }
                case CONDITIONAL_EXPRESSION -> conditionalValue(route,(ConditionalExpressionTree)leaf);
                case LOGICAL_COMPLEMENT, UNARY_MINUS, UNARY_PLUS, BITWISE_COMPLEMENT -> {
                    Value input = expression(new TreePath(route,((UnaryTree)leaf).getExpression()));
                    yield new Value(input.inputs(),leaf.getKind()==Tree.Kind.LOGICAL_COMPLEMENT?FlowFacts.negated(input.fact()):FlowFacts.UNKNOWN);
                }
                case PLUS, MINUS, MULTIPLY, DIVIDE, REMAINDER, LEFT_SHIFT, RIGHT_SHIFT, UNSIGNED_RIGHT_SHIFT,
                     LESS_THAN, LESS_THAN_EQUAL, GREATER_THAN, GREATER_THAN_EQUAL, EQUAL_TO, NOT_EQUAL_TO,
                     AND, OR, XOR, CONDITIONAL_AND, CONDITIONAL_OR -> binaryValue(route,(BinaryTree)leaf);
                default -> throw outsideScope();
            };
        }

        private Value binaryValue(TreePath route, BinaryTree binary) {
            Tree.Kind kind = binary.getKind();
            boolean shortCircuit = kind == Tree.Kind.CONDITIONAL_AND || kind == Tree.Kind.CONDITIONAL_OR;
            if (shortCircuit && calls == null) throw outsideScope();
            Value first = expression(new TreePath(route,binary.getLeftOperand()));
            if (shortCircuit && Boolean.valueOf(kind==Tree.Kind.CONDITIONAL_OR).equals(first.fact())) return first;
            Value second = expression(new TreePath(route,binary.getRightOperand()));
            List<Integer> inputs = new ArrayList<>(first.inputs());
            inputs.addAll(second.inputs());
            return new Value(inputs,FlowFacts.binary(kind,first.fact(),second.fact()));
        }

        private Value conditionalValue(TreePath route, ConditionalExpressionTree ternary) {
            if (calls == null) throw outsideScope();
            Value condition = expression(new TreePath(route,ternary.getCondition()));
            List<Integer> inputs = new ArrayList<>(condition.inputs());
            List<Object> facts = new ArrayList<>();
            for (boolean side : new boolean[]{true,false}) {
                if (Boolean.valueOf(!side).equals(condition.fact())) continue;
                var node = side ? ternary.getTrueExpression() : ternary.getFalseExpression();
                Value result = expression(new TreePath(route,node));
                inputs.add(valueEvent(side?"true-value":"false-value",side?"If true":"If false",start(node),end(node),
                    controlled(result.inputs()),result.fact()));
                facts.add(result.fact());
            }
            Object merged = facts.size()==1 ? facts.getFirst() : FlowFacts.common(facts.getFirst(),facts.getLast());
            Object fact = FlowFacts.stored(trees.getTypeMirror(route),merged);
            return new Value(List.of(valueEvent("choice","Conditional value",start(ternary),end(ternary),controlled(inputs),fact)),fact);
        }

        void assign(TreePath route, AssignmentTree assignment, IdentifierTree target) {
            VariableElement variable = variable(new TreePath(route,target));
            Value input = expression(new TreePath(route,assignment.getExpression()));
            definitions.put(variable,valueEvent("assignment",variable.getSimpleName().toString(),start(target),end(target),
                controlled(input.inputs()),FlowFacts.stored(variable.asType(),input.fact())));
        }

        int returnValue(TreePath route, ReturnTree returned) {
            Value input = expression(new TreePath(route,returned.getExpression()));
            return valueEvent("return","return",start(returned),start(returned)+6,controlled(input.inputs()),input.fact());
        }

        int trace(TreePath methodPath, List<Integer> arguments) {
            MethodTree node = (MethodTree) methodPath.getLeaf();
            for (int index = 0; index < node.getParameters().size(); index++) {
                VariableTree parameter = node.getParameters().get(index);
                declaration(new TreePath(methodPath,parameter),parameter,true,arguments.isEmpty()?List.of():List.of(arguments.get(index)));
            }
            TreePath body = new TreePath(methodPath,node.getBody());
            if (calls != null) return new BranchFlow(this).trace(body);
            int returnedValue = -1;
            for (StatementTree statement : node.getBody().getStatements()) {
                TreePath line = new TreePath(body,statement);
                if (statement instanceof VariableTree local) {
                    declaration(line,local,false,List.of());
                } else if (statement instanceof ExpressionStatementTree expr && expr.getExpression() instanceof AssignmentTree assignment
                        && assignment.getVariable() instanceof IdentifierTree target) {
                    assign(new TreePath(line,assignment),assignment,target);
                } else if (statement instanceof ReturnTree returned && returned.getExpression() != null) {
                    returnedValue = returnValue(line,returned);
                } else if (statement.getKind() != Tree.Kind.EMPTY_STATEMENT) {
                    throw outsideScope();
                }
            }
            return returnedValue;
        }
    }

    static TreePath flowMethod(CompilationUnitTree unit, Trees trees, int offset) {
        var selected = new TreePath[1];
        var positions = trees.getSourcePositions();
        new TreePathScanner<Void,Void>() {
            @Override public Void visitMethod(MethodTree method, Void unused) {
                if (method.getBody() != null && positions.getStartPosition(unit,method) <= offset
                        && positions.getEndPosition(unit,method) > offset) selected[0] = getCurrentPath();
                return super.visitMethod(method,unused);
            }
        }.scan(unit,null);
        return selected[0];
    }

    static Map<String,Object> dataFlow(List<CompilationUnitTree> units, Trees trees, Map<String,Source> sources, String uri, int offset) {
        for (var unit : units) {
            if (!unit.getSourceFile().toUri().toString().equals(uri)) continue;
            var selected = flowMethod(unit,trees,offset);
            if (selected == null) return object("error","Place the cursor in a Java method.");
            try {
                var flow = new Flow(unit,trees,sources.get(uri).text);
                flow.trace(selected,List.of());
                return object("uri",uri,"events",flow.events.stream().map(event->event.output(false)).toList());
            } catch (UnsupportedOperationException outside) {
                return object("error",outside.getMessage());
            }
        }
        return object("error","The selected Java source is outside the compiler scope.");
    }

    static Map<String,Object> typeImport(CompilationUnitTree unit,Trees trees,int from,int to,String expected) {
        var positions=trees.getSourcePositions();
        var bindings=new ArrayList<Map<String,Object>>();
        String[] selected={null};
        String simple=expected.substring(expected.lastIndexOf('.')+1);
        new TreePathScanner<Void,Void>() {
            @Override public Void visitIdentifier(IdentifierTree tree,Void unused) {
                if(tree.getName().contentEquals(simple)&&trees.getElement(getCurrentPath()) instanceof TypeElement type) {
                    long start=positions.getStartPosition(unit,tree),end=positions.getEndPosition(unit,tree);
                    String qualified=type.getQualifiedName().toString();
                    bindings.add(object("start",start,"end",end,"type",qualified));
                    if(start==from&&end==to)selected[0]=qualified;
                }
                return super.visitIdentifier(tree,unused);
            }
        }.scan(unit,null);
        return object("target",selected[0],"bindings",bindings);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 4 && !(args.length == 5 && Set.of("diagram","hierarchy","attributedDependencies").contains(args[4])) &&
                !(args.length >= 6 && args.length <= 37 && args[4].equals("advisoryCalls")) &&
                !(args.length == 7 && args[4].equals("dataflow")) &&
                !(args.length == 9 && args[4].equals("callFlow")) &&
                !(args.length == 6 && args[4].equals("conversion")) &&
                !(args.length == 7 && args[4].equals("groovyMembers")) &&
                !(args.length >= 7 && args.length <= 36 && args[4].equals("parameterNameBindings")) &&
                !(args.length == 6 && args[4].equals("binaryBeanLifecycle")) &&
                !(args.length == 9 && args[4].equals("constant")) &&
                !(args.length == 9 && args[4].equals("extraction")) &&
                !(args.length == 10 && args[4].equals("methodInline")) &&
                !(args.length == 9 && args[4].equals("expectedCompletion")) &&
                !(args.length == 8 && args[4].equals("springQualifier")) &&
                !(args.length == 8 && args[4].equals("typeStructure")) &&
                !(args.length == 10 && args[4].equals("methodExtract")) &&
                !(args.length == 7 && args[4].equals("cleanup")) &&
                !(args.length == 7 && Set.of("typeRename","typeRenameBinary","packageRename").contains(args[4])) &&
                !(args.length == 9 && Set.of("typeImport", "staticImport").contains(args[4])) &&
                !(args.length == 5 && args[4].equals("check")) &&
                !(args.length >= 9 && args.length <= 57 && (args.length - 9) % 3 == 0 && args[4].equals("structural"))) {
            throw new IllegalArgumentException("Use classpath-file, source-list, empty-provider-path and release.");
        }
        String classpath = Files.readString(Path.of(args[0]), StandardCharsets.UTF_8);
        List<Source> sources = new ArrayList<>(); Map<String, Source> byUri = new HashMap<>();
        for (String line : Files.readAllLines(Path.of(args[1]), StandardCharsets.UTF_8)) {
            String[] parts = line.split("\t", -1); if (parts.length != 2 || sources.size() >= 500) throw new IllegalArgumentException("Invalid bounded source list.");
            Source source = new Source(parts[0], new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8)); sources.add(source); byUri.put(source.toUri().toString(), source);
        }
        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler(); if (compiler == null) throw new IllegalStateException("A full independent JDK is required.");
        DiagnosticCollector<JavaFileObject> diagnostics = new DiagnosticCollector<>();
        boolean namedModule = sources.stream().anyMatch(source -> source.toUri().getPath().endsWith("/module-info.java"));
        try (StandardJavaFileManager standard = compiler.getStandardFileManager(diagnostics, Locale.ROOT, StandardCharsets.UTF_8)) {
            JavaFileManager files = new ForwardingJavaFileManager<StandardJavaFileManager>(standard) {
                public JavaFileObject getJavaFileForOutput(Location location, String name, JavaFileObject.Kind kind, FileObject sibling) throws IOException { throw new IOException("Class generation is disabled."); }
                @Override
                public boolean contains(Location location, FileObject input) throws IOException {
                    // javac requires every source unit to belong to a named module location.
                    // Explicit in-memory inputs play the source path role without a filesystem lookup.
                    if (namedModule && input instanceof Source) return location == StandardLocation.SOURCE_PATH;
                    return super.contains(location, input);
                }
            };
            List<String> options = List.of("-proc:none", "-implicit:none", "-Xlint:none", "-encoding", "UTF-8", "-sourcepath", args[2], "-processorpath", args[2], "-classpath", classpath, "--release", args[3]);
            StringWriter compilerOutput = new StringWriter();
            JavacTask task = (JavacTask) compiler.getTask(compilerOutput, files, diagnostics, options, null, sources);
            List<CompilationUnitTree> units = new ArrayList<>(); task.parse().forEach(units::add); task.analyze();
            Trees trees = Trees.instance(task); Elements elements = task.getElements(); Types types=task.getTypes(); SourcePositions positions = trees.getSourcePositions();
            if (args.length > 4) {
                System.setOut(new PrintStream(System.out,false,StandardCharsets.UTF_8));
                var problems = errors(diagnostics);
                Map<String,Object> report = object("format","RocketbrainSignatureCompiler-v20","processorsEnabled",false,
                    "classGenerationEnabled",false,"errors",problems);
                if (problems.isEmpty()) {
                    if (args[4].equals("diagram")) report.put("declarations",diagrams(units,trees,types));
                    else if (args[4].equals("attributedDependencies")) {
                        report.put("attributedDependencies",new AttributedDependencies(trees,byUri.keySet()).inspect(units));
                    }
                    else if (args[4].equals("typeRename")) report.put("typeRename",TypeRenameInspector.inspect(task,units,args[5],args[6]));
                    else if (args[4].equals("packageRename")) report.put("packageRename",new PackageRenameInspector(task,args[5],args[6]).inspect(units));
                    else if (args[4].equals("typeRenameBinary")) report.put("typeRename",TypeRenameInspector.inspect(task,units,args[5],args[6],true));
                    else if (args[4].equals("advisoryCalls")) {
                        report.put("advisoryCalls",new AdvisoryCalls(trees,elements,types,files,classpath,
                            Arrays.asList(args).subList(5,args.length)).inspect(units));
                    }
                    else if (args[4].equals("groovyMembers")) {
                        report.put("groovyMembers", GroovyJavaMembers.inspect(elements, trees, args[5], args[6]));
                    }
                    else if (args[4].equals("parameterNameBindings")) {
                        report.put("parameterNameBindings", ParameterNameBindings.inspect(task, units,
                            new LinkedHashSet<>(Arrays.asList(args).subList(6, args.length)), Integer.parseInt(args[5])));
                    }
                    else if (args[4].equals("binaryBeanLifecycle")) {
                        report.put("binaryBeanLifecycle", new BinaryBeanLifecycle(trees, elements, files, classpath)
                            .inspect(units, args[5]));
                    }
                    else if (args[4].equals("hierarchy")) report.put("hierarchy",new HierarchyInspector(task).inspect(units,byUri));
                    else if (args[4].equals("dataflow")) report.put("dataFlow",dataFlow(units,trees,byUri,args[5],Integer.parseInt(args[6])));
                    else if (args[4].equals("callFlow")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("callFlow",new CallFlowInspector(trees,byUri)
                            .inspect(units,unit,Integer.parseInt(args[6]),args[7],Integer.parseInt(args[8])));
                    }
                    else if (args[4].equals("conversion")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("conversions",new ConversionInspector(task,unit,byUri.get(args[5]).text).inspect());
                    }
                    else if (args[4].equals("cleanup")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("cleanup",new CleanupInspector(unit,trees,byUri.get(args[5]).text,args[6].equals("plan")).inspect());
                    }
                    else if (args[4].equals("constant")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("constant",new ConstantInspector(task,unit).inspect(Integer.parseInt(args[6]),Integer.parseInt(args[7]),args[8]));
                    }
                    else if (args[4].equals("extraction")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("extraction",new ExtractionInspector(task,unit,byUri.get(args[5]).text).inspect(args[6],Integer.parseInt(args[7]),args[8]));
                    }
                    else if (args[4].equals("methodInline")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("methodInline",new InlineMethodInspector(task,unit,byUri.get(args[5]).text)
                            .inspect(Integer.parseInt(args[6]),Integer.parseInt(args[7]),Integer.parseInt(args[8]),args[9]));
                    }
                    else if (args[4].equals("expectedCompletion")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("expectedCompletion",new ExpectedCompletion(task,unit)
                            .inspect(Integer.parseInt(args[6]),Integer.parseInt(args[7]),args[8].equals("plan")));
                    }
                    else if (args[4].equals("springQualifier")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("springQualifier",new SpringQualifierInspector(task)
                            .inspect(units,unit,Integer.parseInt(args[6]),Integer.parseInt(args[7])));
                    }
                    else if (args[4].equals("typeStructure")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("typeStructure",new StructureInspector(task,byUri).inspect(unit,Integer.parseInt(args[6]),args[7]));
                    }
                    else if (args[4].equals("methodExtract")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("methodExtract",new ExtractMethodInspector(task,unit,byUri.get(args[5]).text)
                            .inspect(Integer.parseInt(args[6]),Integer.parseInt(args[7]),args[8],Integer.parseInt(args[9])));
                    }
                    else if (args[4].equals("typeImport")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("typeImport",typeImport(unit,trees,Integer.parseInt(args[6]),Integer.parseInt(args[7]),args[8]));
                    }
                    else if (args[4].equals("staticImport")) {
                        var unit = units.stream().filter(item -> item.getSourceFile().toUri().toString().equals(args[5])).findFirst().orElseThrow();
                        report.put("staticImport",StaticImportInspector.inspect(unit,trees,Integer.parseInt(args[6]),Integer.parseInt(args[7]),args[8]));
                    }
                    else if (args[4].equals("structural")) {
                        report.put("structural",new StructuralSearch(task).search(compiler,files,options,units,byUri,args));
                    }
                }
                System.out.print(json(report));
                return;
            }
            List<Method> methods = new ArrayList<>(); List<Map<String, Object>> calls = new ArrayList<>(); List<Map<String, Object>> references = new ArrayList<>();
            List<Map<String,Object>> lambdas = new ArrayList<>();
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
                        if (executable.getModifiers().contains(Modifier.PRIVATE)) {
                            method.model.put("checkedThrows", checkedThrownTypes(executable, types, elements));
                        }
                        if (tree.getBody() != null) {
                            var nest = hiddenAccessNest(owner);
                            if (nest != null) method.model.put("hiddenAccessNest", nest);
                        }
                        var returnContract = SignatureReturn.declaration(executable,tree,getCurrentPath(),trees,types);
                        if (!returnContract.isEmpty()) method.model.put("returnContract",returnContract);
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
                        var report = object("uri",uri,"start",start,"end",end,"methodKey",key(executable),
                            "enclosingKey",current==null?"<initializer>":key(current.element),"ordinal",ordinal++,"constructor",constructor,
                            "resultType",trees.getTypeMirror(getCurrentPath()).toString(),
                            "safeArguments",arguments.stream().allMatch(v->safeArgument(getCurrentPath(),v,trees)));
                        if (executable.isVarArgs() && trees.getPath(executable) != null) {
                            var varargs = VarargsCalls.inspect(getCurrentPath(), executable, arguments, trees, types, text);
                            if (!varargs.isEmpty()) report.put("varargs",varargs);
                        }
                        if (!constructor && executable.getModifiers().contains(Modifier.PRIVATE) && trees.getPath(executable) != null) {
                            var consumer = SignatureReturn.consumer(tree,getCurrentPath(),trees,text);
                            if (!consumer.isEmpty()) report.put("returnConsumer",consumer);
                        }
                        calls.add(report);
                    }
                    public Void visitMethodInvocation(MethodInvocationTree tree, Void p) { call(tree,tree.getArguments(),false); return super.visitMethodInvocation(tree,p); }
                    public Void visitNewClass(NewClassTree tree, Void p) { call(tree,tree.getArguments(),true); return super.visitNewClass(tree,p); }
                    String enclosingKey() { return current==null?"<initializer>":key(current.element); }
                    public Void visitMemberReference(MemberReferenceTree tree, Void p) {
                        TreePath member = getCurrentPath();
                        if (trees.getElement(member) instanceof ExecutableElement method) {
                            TypeMirror target = trees.getTypeMirror(member);
                            references.add(object("uri",uri,"methodKey",key(method),"enclosingKey",enclosingKey(),
                                "start",positions.getStartPosition(unit,tree),"end",positions.getEndPosition(unit,tree),
                                "targetType",target==null?null:target.toString(),
                                "adapter",SignatureReferences.adapter(tree,method,member,trees,types,elements,text)));
                        }
                        return super.visitMemberReference(tree,p);
                    }
                    public Void visitLambdaExpression(LambdaExpressionTree tree, Void p) {
                        TypeMirror target = trees.getTypeMirror(getCurrentPath());
                        lambdas.add(object("uri",uri,"enclosingKey",enclosingKey(),"start",positions.getStartPosition(unit,tree),
                            "end",positions.getEndPosition(unit,tree),"targetType",target==null?null:target.toString()));
                        return super.visitLambdaExpression(tree,p);
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
            List<Map<String,Object>> errors=errors(diagnostics);
            System.out.print(json(object("format","RocketbrainSignatureCompiler-v20","processorsEnabled",false,"classGenerationEnabled",false,"errors",errors,"methods",methods.stream().map(m->m.model).toList(),"calls",calls,"methodReferences",references,"lambdas",lambdas,"overrideEdges",edges,"externalOverrides",external)));
        }
    }
}
