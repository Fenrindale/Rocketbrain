package rocketbrain.signature;

import com.sun.source.tree.*;
import com.sun.source.util.*;
import java.io.IOException;
import java.util.*;
import javax.lang.model.element.*;
import javax.lang.model.type.TypeKind;

import static rocketbrain.signature.SignatureInspector.object;

/** Attributes the enclosing receiver, moved body and constructor callers on each side of a member-class move. */
final class InnerMoveInspector {
    private final JavacTask task;
    private final Trees trees;
    private final SourcePositions positions;
    private final TypeElement target;
    private final TypeElement owner;
    private final TreePath declaration;
    private final boolean member;
    private VariableElement ownerField;
    private boolean unsupported;
    private final List<Map<String,Object>> methods = new ArrayList<>();
    private final List<Map<String,Object>> fields = new ArrayList<>();
    private final List<Map<String,Object>> calls = new ArrayList<>();
    private final Map<String,Integer> uses = new LinkedHashMap<>();
    private final Map<String,Map<String,Object>> callers = new LinkedHashMap<>();

    private InnerMoveInspector(JavacTask task, TypeElement target, TypeElement owner) {
        this.task = task;
        this.trees = Trees.instance(task);
        this.positions = trees.getSourcePositions();
        this.target = target;
        this.owner = owner;
        this.declaration = target == null ? null : trees.getPath(target);
        member = target != null && target.getNestingKind() == NestingKind.MEMBER;
    }

    static Map<String,Object> inspect(JavacTask task, List<CompilationUnitTree> units, String name, String ownerName) {
        var elements = task.getElements();
        var inspector = new InnerMoveInspector(task,elements.getTypeElement(name),elements.getTypeElement(ownerName));
        return inspector.inspect(units);
    }

    private Map<String,Object> inspect(List<CompilationUnitTree> units) {
        if (declaration == null || owner == null || !(declaration.getLeaf() instanceof ClassTree type) ||
                target.getKind() != ElementKind.CLASS || owner.getNestingKind() != NestingKind.TOP_LEVEL ||
                owner.getKind() != ElementKind.CLASS || !owner.getTypeParameters().isEmpty() ||
                !target.getTypeParameters().isEmpty() || !target.getAnnotationMirrors().isEmpty() ||
                target.getModifiers().contains(Modifier.STATIC) || target.getModifiers().contains(Modifier.PRIVATE) ||
                target.getModifiers().contains(Modifier.PROTECTED) || type.getExtendsClause() != null ||
                !type.getImplementsClause().isEmpty() || !type.getPermitsClause().isEmpty() ||
                !(member ? owner.equals(target.getEnclosingElement()) : target.getNestingKind()==NestingKind.TOP_LEVEL)) {
            return object("supported",false);
        }
        String topName = task.getElements().getPackageOf(target).getQualifiedName() + "." + target.getSimpleName();
        boolean occupied = member && task.getElements().getTypeElement(topName) != null;
        var unit = declaration.getCompilationUnit();
        var scan = new Scan(unit);
        if (!member && (unit.getTypeDecls().size()!=1 || unit.getTypeDecls().getFirst()!=type)) unsupported=true;
        for (Tree tree : type.getMembers()) {
            if (!scan.concrete(tree)) continue;
            var path = new TreePath(declaration,tree);
            if (tree instanceof VariableTree field && trees.getElement(path) instanceof VariableElement symbol) {
                if (field.getInitializer()!=null || !symbol.getAnnotationMirrors().isEmpty() ||
                        symbol.getModifiers().contains(Modifier.STATIC)) unsupported = true;
                boolean receiver = !member && task.getTypes().isSameType(symbol.asType(),owner.asType()) &&
                        symbol.getModifiers().equals(Set.of(Modifier.PRIVATE,Modifier.FINAL));
                if (receiver) {
                    if (ownerField!=null) unsupported=true;
                    ownerField=symbol;
                } else {
                    fields.add(object("name",symbol.getSimpleName().toString(),"type",symbol.asType().toString(),
                        "modifiers",modifiers(symbol)));
                }
            } else if (!(tree instanceof MethodTree)) unsupported=true;
        }
        if (!member && ownerField==null) unsupported=true;
        int constructors=0;
        for (Tree tree : type.getMembers()) {
            if (!scan.concrete(tree) || !(tree instanceof MethodTree method)) continue;
            var path = new TreePath(declaration,method);
            if (!(trees.getElement(path) instanceof ExecutableElement symbol) || method.getBody()==null ||
                    !symbol.getAnnotationMirrors().isEmpty() || !symbol.getTypeParameters().isEmpty() ||
                    symbol.getModifiers().contains(Modifier.STATIC) || symbol.isVarArgs()) {
                unsupported=true;
                continue;
            }
            boolean constructor=symbol.getKind()==ElementKind.CONSTRUCTOR;
            var parameters=symbol.getParameters();
            if (!symbol.getTypeParameters().isEmpty() || parameters.stream().anyMatch(p->!p.getAnnotationMirrors().isEmpty())) unsupported=true;
            var bodyPath=new TreePath(path,method.getBody());
            var body=new Body(scan);
            if (constructor) {
                constructors++;
                var statements=method.getBody().getStatements().stream().filter(scan::concrete).toList();
                Tree first=statements.isEmpty()?null:statements.getFirst();
                if (!member) {
                    if (parameters.isEmpty() || ownerField==null ||
                            !task.getTypes().isSameType(parameters.getFirst().asType(),owner.asType()) ||
                            !assignment(bodyPath,first,parameters.getFirst())) unsupported=true;
                    else body.replacements.add(new Replacement(scan.start(first),scan.end(first),""));
                } else if (first instanceof ExpressionStatementTree statement &&
                        statement.getExpression() instanceof MethodInvocationTree invocation &&
                        invocation.getMethodSelect() instanceof IdentifierTree select &&
                        Set.of("this","super").contains(select.getName().toString())) unsupported=true;
            }
            body.scan(bodyPath,null);
            int skip=constructor&&!member?1:0;
            if (parameters.size()<skip) continue;
            methods.add(object("name",symbol.getSimpleName().toString(),"parameters",parameters.stream().skip(skip)
                    .map(parameter->parameter.asType().toString()).toList(),
                "throws",symbol.getThrownTypes().stream().map(Object::toString).toList(),
                "returns",symbol.getReturnType().toString(),"modifiers",modifiers(symbol),
                "body",body.text(method.getBody()),"outerBindings",body.outerBindings,"calls",body.callBindings,"references",body.references));
        }
        if (constructors!=1 || member && methods.stream().flatMap(method->((List<?>)method.get("outerBindings")).stream()).findAny().isEmpty())
            unsupported=true;
        for (var each : units) {
            var caller = new CallerScan(each);
            caller.scan(each,null);
            callers.put(caller.uri,object("spans",caller.normalizations,"bindings",caller.bindings));
        }
        return object("supported",!unsupported,"member",member,"destinationOccupied",occupied,"name",target.getSimpleName().toString(),
            "owner",owner.getQualifiedName().toString(),"uri",unit.getSourceFile().toUri().toString(),
            "start",scan.start(type),"end",scan.end(type),"modifiers",modifiers(target),
            "fields",fields,"methods",methods,"calls",calls,"uses",uses,"callers",callers);
    }

    private boolean assignment(TreePath body,Tree first,VariableElement parameter) {
        if (!(first instanceof ExpressionStatementTree statement) ||
                !(statement.getExpression() instanceof AssignmentTree assignment)) return false;
        var path=new TreePath(new TreePath(body,statement),assignment);
        return ownerField.equals(trees.getElement(new TreePath(path,assignment.getVariable()))) &&
            parameter.equals(trees.getElement(new TreePath(path,assignment.getExpression())));
    }

    private static List<String> modifiers(Element binding) {
        return binding.getModifiers().stream().map(Modifier::name).sorted().toList();
    }

    private String identity(Element binding) {
        if (binding==null) return "";
        Element receiver=binding.getEnclosingElement();
        String declared=target.equals(receiver)?"<moved>":receiver.toString();
        return declared+"#"+binding.getSimpleName()+"#"+binding.asType();
    }

    private class Scan extends TreePathScanner<Void,Void> {
        final CompilationUnitTree unit;
        final String text;
        final String uri;
        Scan(CompilationUnitTree unit) {
            this.unit=unit;
            uri=unit.getSourceFile().toUri().toString();
            try { text=unit.getSourceFile().getCharContent(true).toString(); }
            catch (IOException error) { throw new IllegalStateException("Cannot read the attributed Java source.",error); }
        }
        int start(Tree node){return (int)positions.getStartPosition(unit,node);}
        int end(Tree node){return (int)positions.getEndPosition(unit,node);}
        boolean concrete(Tree node){return start(node)>=0 && end(node)>start(node) && end(node)<=text.length();}
        Map<String,Object> span(Tree node){return object("start",start(node),"end",end(node),"text",text.substring(start(node),end(node)));}
        Element binding(){return trees.getElement(getCurrentPath());}
    }

    private record Replacement(int start,int end,String text) {}

    private final class Body extends TreePathScanner<Void,Void> {
        final Scan scan;
        final List<Replacement> replacements=new ArrayList<>();
        final List<String> outerBindings=new ArrayList<>(),callBindings=new ArrayList<>(),references=new ArrayList<>();
        Body(Scan scan){this.scan=scan;}

        boolean outerThis(TreePath path) {
            if (!(path.getLeaf() instanceof MemberSelectTree select) || !select.getIdentifier().contentEquals("this")) return false;
            return owner.equals(trees.getElement(new TreePath(path,select.getExpression())));
        }

        boolean outerMember(Element binding) {
            return binding!=null && owner.equals(binding.getEnclosingElement()) &&
                (binding.getKind()==ElementKind.FIELD || binding.getKind()==ElementKind.METHOD) &&
                !binding.getModifiers().contains(Modifier.STATIC);
        }

        void replace(Tree node,String text,String binding) {
            replacements.add(new Replacement(scan.start(node),scan.end(node),text));
            outerBindings.add(binding);
        }

        @Override public Void visitMethodInvocation(MethodInvocationTree node,Void unused) {
            if (scan.concrete(node)) callBindings.add(identity(trees.getElement(getCurrentPath())));
            return super.visitMethodInvocation(node,unused);
        }

        void reference(Element binding) {
            if (binding!=null && (binding instanceof TypeElement || binding.getKind().isField()) &&
                !Set.of("this","super").contains(binding.getSimpleName().toString()) && !binding.equals(ownerField)) references.add(identity(binding));
        }

        @Override public Void visitIdentifier(IdentifierTree node,Void unused) {
            Element binding=trees.getElement(getCurrentPath());
            if (scan.concrete(node) && outerMember(binding)) {
                if (!member || binding.getModifiers().contains(Modifier.PRIVATE)) unsupported=true;
                replace(node,"__rbOuter."+node.getName(),identity(binding));
            } else if (scan.concrete(node)) reference(binding);
            return super.visitIdentifier(node,unused);
        }

        @Override public Void visitMemberSelect(MemberSelectTree node,Void unused) {
            if (!scan.concrete(node)) return super.visitMemberSelect(node,unused);
            Element binding=trees.getElement(getCurrentPath());
            if (outerMember(binding)) {
                var qualifier=new TreePath(getCurrentPath(),node.getExpression());
                if (!(member ? outerThis(qualifier) : ownerField!=null && ownerField.equals(trees.getElement(qualifier))) ||
                        binding.getModifiers().contains(Modifier.PRIVATE)) unsupported=true;
                replace(node,"__rbOuter."+node.getIdentifier(),identity(binding));
                return null;
            }
            if (member && outerThis(getCurrentPath())) {
                replace(node,"__rbOuter",owner.getQualifiedName()+"#this");
                return null;
            }
            if (!member && ownerField!=null && ownerField.equals(binding)) {
                // The assignment introduced by the engine is already omitted from the canonical constructor.
                if (replacements.stream().noneMatch(edit->edit.text().isEmpty() && edit.start()<=scan.start(node) && edit.end()>=scan.end(node)))
                    replace(node,"__rbOuter",owner.getQualifiedName()+"#this");
                return null;
            }
            reference(binding);
            return super.visitMemberSelect(node,unused);
        }

        @Override public Void visitClass(ClassTree node,Void unused) {
            unsupported=true;
            return null;
        }

        String text(BlockTree block) {
            var out=new StringBuilder();
            int cursor=scan.start(block);
            for (var edit:replacements.stream().sorted(Comparator.comparingInt(Replacement::start)).toList()) {
                if (edit.start()<cursor || edit.end()>scan.end(block)) { unsupported=true; continue; }
                out.append(scan.text,cursor,edit.start()).append(edit.text());
                cursor=edit.end();
            }
            return out.append(scan.text,cursor,scan.end(block)).toString();
        }
    }

    private final class CallerScan extends Scan {
        final List<Map<String,Object>> normalizations=new ArrayList<>();
        final List<String> bindings=new ArrayList<>();
        final Set<Tree> nullGuards=Collections.newSetFromMap(new IdentityHashMap<>());
        CallerScan(CompilationUnitTree unit){super(unit);}
        void normalize(Tree node,String symbol){normalizations.add(object("start",start(node),"end",end(node),"symbol",symbol));}
        Map<String,Object> expression(TreePath parent,Tree node) {
            var value=span(node);
            var type=trees.getTypeMirror(new TreePath(parent,node));
            value.put("type",type==null?"":type.toString());
            return value;
        }
        void bound(Element binding) {
            if (binding==null) return;
            String fqn=target.getQualifiedName().toString();
            var exact=java.util.regex.Pattern.compile("(?<![\\w$.])"+java.util.regex.Pattern.quote(fqn)+"(?![\\w$.])");
            bindings.add(exact.matcher(identity(binding)).replaceAll("<moved>"));
        }
        boolean withinMoved() {
            for (TreePath p=getCurrentPath();p!=null;p=p.getParentPath()) if (p.getLeaf()==declaration.getLeaf()) return true;
            return false;
        }
        void use(Tree node){uses.merge(uri,1,Integer::sum); if (!withinMoved()) normalize(node,"__rbType");}
        @Override public Void visitImport(ImportTree node,Void unused){
            if (!node.isStatic() && node.getQualifiedIdentifier().toString().equals(target.getQualifiedName().toString())) normalize(node,"");
            return null;
        }
        @Override public Void visitMethodInvocation(MethodInvocationTree node,Void unused) {
            if (concrete(node)&&!withinMoved()&&!nullGuards.contains(node)) bound(binding());
            return super.visitMethodInvocation(node,unused);
        }

        @Override public Void visitIdentifier(IdentifierTree node,Void unused) {
            if (concrete(node)&&target.equals(binding()))use(node);
            return super.visitIdentifier(node,unused);
        }
        @Override public Void visitMemberSelect(MemberSelectTree node,Void unused) {
            if (concrete(node)&&target.equals(binding()))use(node);
            if (node.getIdentifier().contentEquals("class") &&
                    target.equals(trees.getElement(new TreePath(getCurrentPath(),node.getExpression())))) unsupported=true;
            return super.visitMemberSelect(node,unused);
        }
        @Override public Void visitMemberReference(MemberReferenceTree node,Void unused) {
            if (node.getMode()==MemberReferenceTree.ReferenceMode.NEW && binding() instanceof ExecutableElement constructor &&
                    target.equals(constructor.getEnclosingElement())) unsupported=true;
            if (concrete(node)&&!withinMoved()) bound(binding());
            return super.visitMemberReference(node,unused);
        }
        @Override public Void visitClass(ClassTree node,Void unused) {
            if (node==declaration.getLeaf()) normalize(node,"");
            if (node.getExtendsClause()!=null &&
                    target.equals(trees.getElement(new TreePath(getCurrentPath(),node.getExtendsClause())))) unsupported=true;
            return super.visitClass(node,unused);
        }
        @Override public Void visitLiteral(LiteralTree node,Void unused) {
            if (node.getValue() instanceof String value && (value.equals(target.getQualifiedName().toString()) ||
                    value.equals(task.getElements().getBinaryName(target).toString()))) unsupported=true;
            return super.visitLiteral(node,unused);
        }
        @Override public Void visitNewClass(NewClassTree node,Void unused) {
            if (concrete(node)&&binding() instanceof ExecutableElement constructor&&target.equals(constructor.getEnclosingElement())) {
                normalize(node,"__rbConstruction");
                if (withinMoved()||node.getClassBody()!=null||!node.getTypeArguments().isEmpty()||
                        node.getArguments().stream().anyMatch(arg->!concrete(arg))) unsupported=true;
                var qualifier=node.getEnclosingExpression();
                if (member&&qualifier==null) {
                    TreePath p=getCurrentPath().getParentPath();
                    while (p!=null && !(p.getLeaf() instanceof ClassTree)) p=p.getParentPath();
                    if (p==null||!owner.equals(trees.getElement(p))) unsupported=true;
                }
                boolean nonNull=false;
                Map<String,Object> guardedOwner=null;
                if (!member && !node.getArguments().isEmpty() && node.getArguments().getFirst() instanceof MethodInvocationTree check
                        && check.getArguments().size()==1) {
                    var checkPath=new TreePath(getCurrentPath(),check);
                    var method=trees.getElement(checkPath);
                    nonNull=method instanceof ExecutableElement executable &&
                        executable.getSimpleName().contentEquals("requireNonNull") &&
                        executable.getEnclosingElement().toString().equals("java.util.Objects") &&
                        executable.getParameters().size()==1;
                    if (nonNull) {
                        nullGuards.add(check);
                        guardedOwner=expression(checkPath,check.getArguments().getFirst());
                    }
                }
                calls.add(object("uri",uri,"start",start(node),"end",end(node),
                    "qualifier",qualifier==null?null:expression(getCurrentPath(),qualifier),
                    "arguments",node.getArguments().stream().filter(this::concrete).map(arg->expression(getCurrentPath(),arg)).toList(),
                    "ownerNullChecked",nonNull,"guardedOwner",guardedOwner));
                if (calls.size()>1000) throw new IllegalArgumentException("Too many Java inner-class constructor callers to review.");
            } else if (concrete(node)&&!withinMoved()) bound(binding());
            return super.visitNewClass(node,unused);
        }
    }
}
